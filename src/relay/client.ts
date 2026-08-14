/**
 * 릴레이 클라이언트 — 코어가 암호문을 보내고 받는 통로
 *
 * 설계 근거는 docs/architecture.md §4「메시 코어」.
 *
 * 이 모듈은 **암호를 모른다.** 봉투 바이트를 그대로 실어 나를 뿐이고,
 * 무엇을 보내고 받을지는 `Node` 가 정한다. 그래서 릴레이 프로토콜이 바뀌어도
 * 암호 경로는 영향을 받지 않는다.
 *
 * 폴링이다. 릴레이가 §10.7 대로 logic-stateless 이므로 밀어 줄 연결을
 * 유지하지 못한다 — 받는 쪽이 주기적으로 꺼내 가는 것이 유일한 방법이다.
 */
import { fromBase64, type PostBody, type FetchBody, type ErrorBody } from './http.ts'

/** 폴링 간격 기본값. 즉시성과 요청 수의 타협점. */
export const DEFAULT_POLL_MS = 2000

/** 연속 실패 시 최대 백오프. 릴레이가 죽어도 요청을 폭주시키지 않는다. */
export const MAX_BACKOFF_MS = 60_000

export interface ClientOptions {
  /** 릴레이 기준 URL. 예: `https://relay.example.com` */
  readonly baseUrl: string
  /** 내 KEM key id — 내 수신함 주소다. */
  readonly keyId: Uint8Array
  readonly pollMs?: number
  /** 테스트·서버리스에서 주입한다. 기본은 전역 `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

/**
 * 릴레이 클라이언트.
 *
 * 봉투 하나를 보내고, 내 수신함을 비우며 가져온다. 그 둘뿐이다.
 */
export class RelayClient {
  private readonly base: string
  private readonly keyIdHex: string
  private readonly pollMs: number
  private readonly http: typeof globalThis.fetch
  private stopped = false

  constructor(options: ClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '')
    this.keyIdHex = hex(options.keyId)
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** 봉투를 릴레이에 올린다. 실패는 던진다 — 조용한 유실이 최악이다. */
  async post(wire: Uint8Array): Promise<PostBody> {
    const res = await this.http(`${this.base}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: wire,
    })
    const body = (await res.json()) as PostBody | ErrorBody
    if (!res.ok || !body.ok) {
      const err = body as ErrorBody
      throw new RelayError(`릴레이가 거부했다: ${err.detail ?? res.statusText}`, res.status, err.reason)
    }
    return body
  }

  /** 내 수신함을 비우며 가져온다. 봉투 바이트만 돌려준다. */
  async fetchInbox(): Promise<Uint8Array[]> {
    const res = await this.http(`${this.base}/fetch/${this.keyIdHex}`)
    const body = (await res.json()) as FetchBody | ErrorBody
    if (!res.ok || !body.ok) {
      const err = body as ErrorBody
      throw new RelayError(`수신함 조회 실패: ${err.detail ?? res.statusText}`, res.status, err.reason)
    }
    return body.messages.map(m => fromBase64(m.envelope))
  }

  /**
   * 폴링 루프. 도착한 봉투를 하나씩 `onEnvelope` 에 넘긴다.
   *
   * 오류를 던지지 않고 `onError` 로 넘긴 뒤 백오프한다 — 릴레이가 잠깐
   * 죽었다고 브릿지까지 죽으면 안 된다. 릴레이는 신뢰 대상이 아니고,
   * 신뢰하지 않는 것에는 가용성도 기대하지 않는다.
   *
   * 봉투 처리 중 오류도 삼킨다. 봉투 하나가 나빠서 루프가 멈추면 그것이
   * 곧 서비스 거부다 — 나쁜 봉투를 보내는 것은 누구나 할 수 있다.
   */
  async *poll(): AsyncGenerator<Uint8Array, void, void> {
    let backoff = this.pollMs
    while (!this.stopped) {
      let batch: Uint8Array[] = []
      try {
        batch = await this.fetchInbox()
        backoff = this.pollMs
      } catch {
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
      for (const wire of batch) {
        if (this.stopped) return
        yield wire
      }
      // 받은 것이 있으면 곧바로 다시 조회한다 — 밀린 큐를 비우는 중일 수 있다.
      if (batch.length === 0) await sleep(backoff)
    }
  }

  /** 폴링을 멈춘다. 진행 중인 요청은 끝나고 다음 회차가 돌지 않는다. */
  stop(): void {
    this.stopped = true
  }

  get running(): boolean {
    return !this.stopped
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
