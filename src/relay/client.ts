/**
 * 릴레이 클라이언트 — 코어가 암호문을 보내고 받는 통로
 *
 * 설계 근거는 docs/architecture.md §4「메시 코어」.
 *
 * 이 모듈은 봉투 **본문에 대해서는** 암호를 모른다. 봉투 바이트를 그대로 실어
 * 나를 뿐이고, 무엇을 보내고 받을지는 `Node` 가 정한다. 그래서 릴레이
 * 프로토콜이 바뀌어도 암복호 경로는 영향을 받지 않는다.
 *
 * 다만 **수신함 조회는 신원에 묶인다.** §10.12 가 폴링하는 쪽에 키 소유 증명을
 * 요구하기 때문이다 — 큐는 꺼내면 사라지므로, 증명 없이 드레인을 허용하면
 * 누구나 남의 메시지를 가져가고 주인은 영영 받지 못한다. 그래서 이 모듈은
 * `Identity` 를 들고 있고 조회 요청에 Ed25519 서명 하나를 붙인다. 그 하나뿐이며,
 * 본문 봉인·개봉은 여전히 `Node` 가 갖는다.
 *
 * 서명자 콜백으로 감싸 "암호를 모르는 척" 하지 않는다 — 개인키가 필요하다는
 * 사실은 한 겹 덮는다고 사라지지 않고, 덮으면 호출자가 그 사실을 잊는다.
 *
 * 폴링이다. 릴레이가 §10.7 대로 logic-stateless 이므로 밀어 줄 연결을
 * 유지하지 못한다 — 받는 쪽이 주기적으로 꺼내 가는 것이 유일한 방법이다.
 */
import { sign, type Identity } from '../identity/keys.js'
import { fromBase64, type PostBody, type FetchBody, type ErrorBody } from './http.js'
import { fetchAuthHeaders, fetchSigningBytes, newFetchNonce } from './fetch-auth.js'
import { HEADER_POST_AUTH } from './post-auth.js'

/** 첫 폴링 간격 기본값. 첫 메시지는 빠르게 확인한다. */
export const DEFAULT_POLL_MS = 2000

/**
 * 유휴 수신함 폴링의 최대 간격.
 *
 * 빈 수신함을 계속 2초마다 조회하면 메시지가 없어도 Upstash 명령을 쓴다.
 * 2초에서 시작해 이 값까지 지수 백오프하면 유휴 프로세스 하나의 조회는
 * 한 달 약 8,640회(30일 기준)로 묶인다. 실제 전달은 훅·inbox가 맡고, 이
 * 폴링은 그 안전망이므로 유휴 상태에서 5분 지연을 허용한다.
 */
export const DEFAULT_POLL_MAX_MS = 5 * 60 * 1000

/** 연속 실패 시에도 같은 비용 상한을 쓴다. 릴레이가 죽어도 요청을 폭주시키지 않는다. */
export const MAX_BACKOFF_MS = DEFAULT_POLL_MAX_MS

export interface ClientOptions {
  /** 릴레이 기준 URL. 예: `https://relay.example.com` */
  readonly baseUrl: string
  /**
   * 내 신원. key id 는 여기서 파생한다 — 내 수신함 주소다.
   *
   * 선택 항목이 아니다. §10.12 의 조회 인증에 서명이 필요하므로 신원이 없으면
   * 릴레이가 401 을 준다. 타입으로 막을 수 있는 것을 런타임 실패로 미루지 않는다.
   */
  readonly identity: Identity
  /**
   * 릴레이 쓰기 토큰 (§10.13). 그 릴레이가 요구하면 있어야 한다.
   *
   * 선택 항목인 이유는 루프백 릴레이가 인증 없이 뜨기 때문이다 — 로컬 개발에
   * 토큰을 강요하지 않는다. 필요한데 없으면 릴레이가 401 로 답하고, `post()`
   * 가 그 사실을 그대로 던진다. 조용히 실패하지 않는다.
  */
  readonly relayToken?: string
  readonly pollMs?: number
  /** 빈 수신함·연속 실패 때 올라갈 최대 폴링 간격. */
  readonly pollMaxMs?: number
  /** 테스트에서 시간 흐름을 주입한다. 기본은 전역 타이머다. */
  readonly sleep?: (ms: number) => Promise<void>
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
  private readonly identity: Identity
  private readonly keyIdHex: string
  private readonly postHeaders: Record<string, string>
  private readonly pollMs: number
  private readonly pollMaxMs: number
  private readonly http: typeof globalThis.fetch
  private readonly wait: (ms: number) => Promise<void>
  private stopped = false

  constructor(options: ClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '')
    this.identity = options.identity
    this.keyIdHex = hex(options.identity.keyId)
    this.postHeaders = {
      'content-type': 'application/octet-stream',
      ...(options.relayToken ? { [HEADER_POST_AUTH]: `Bearer ${options.relayToken}` } : {}),
    }
    this.pollMs = positive(options.pollMs, DEFAULT_POLL_MS)
    this.pollMaxMs = Math.max(this.pollMs, positive(options.pollMaxMs, DEFAULT_POLL_MAX_MS))
    this.wait = options.sleep ?? sleep
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** 봉투를 릴레이에 올린다. 실패는 던진다 — 조용한 유실이 최악이다. */
  async post(wire: Uint8Array): Promise<PostBody> {
    const res = await this.http(`${this.base}/post`, {
      method: 'POST',
      headers: this.postHeaders,
      body: wire,
    })
    const body = (await res.json()) as PostBody | ErrorBody
    if (!res.ok || !body.ok) {
      const err = body as ErrorBody
      throw new RelayError(`릴레이가 거부했다: ${err.detail ?? res.statusText}`, res.status, err.reason)
    }
    return body
  }

  /**
   * 내 수신함을 비우며 가져온다. 봉투 바이트만 돌려준다.
   *
   * 매 요청마다 새 nonce 로 서명한다 (§10.12). 서명 대상 바이트는 릴레이와
   * 같은 `fetchSigningBytes` 로 만든다 — 양쪽이 각자 조립하면 언젠가 갈린다.
   */
  async fetchInbox(): Promise<Uint8Array[]> {
    const nonce = newFetchNonce()
    const timeMs = Date.now()
    const message = fetchSigningBytes(this.identity.keyId, timeMs, nonce)
    const headers = fetchAuthHeaders({
      kemPublicKey: this.identity.kemPublicKey,
      signPublicKey: this.identity.signPublicKey,
      signature: sign(this.identity, message),
      timeMs,
      nonce,
    })

    const res = await this.http(`${this.base}/fetch/${this.keyIdHex}`, { headers })
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
    let delay = this.pollMs
    while (!this.stopped) {
      let batch: Uint8Array[] = []
      try {
        batch = await this.fetchInbox()
        // 메시지가 실제로 왔으면 다음 빈 조회는 다시 빠르게 시작한다.
        if (batch.length > 0) delay = this.pollMs
      } catch {
        // 오류도 빈 응답과 같은 비용 상한 안에 둔다. 계속 401/5xx를 두드리는
        // 것은 장애를 복구하지 못하면서 릴레이 비용만 늘리는 재시도 폭주다.
        delay = nextPollDelay(delay, this.pollMaxMs)
        await this.wait(delay)
        continue
      }
      for (const wire of batch) {
        if (this.stopped) return
        yield wire
      }
      // 받은 것이 있으면 곧바로 다시 조회한다 — 밀린 큐를 비우는 중일 수 있다.
      // 빈 응답은 성공이어도 비용이 든다. 다음 조회 전까지 지수 백오프한다.
      if (batch.length === 0) {
        await this.wait(delay)
        delay = nextPollDelay(delay, this.pollMaxMs)
      }
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

/** 유효하지 않은 선택값은 안전한 기본값으로 되돌린다. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 현재 간격을 두 배로 늘리되 설정된 비용 상한을 넘지 않는다. */
export function nextPollDelay(currentMs: number, maxMs = DEFAULT_POLL_MAX_MS): number {
  const current = positive(currentMs, DEFAULT_POLL_MS)
  const maximum = positive(maxMs, DEFAULT_POLL_MAX_MS)
  return Math.min(current * 2, maximum)
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
