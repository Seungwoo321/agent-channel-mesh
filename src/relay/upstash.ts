/**
 * Upstash Redis 저장소 — 서버리스 배포용 `Store` 구현
 *
 * 설계 근거는 docs/architecture.md §10.7.
 *
 * `MemoryStore` 는 서버리스에서 쓸 수 없다 — 인스턴스마다 메모리가 갈려서
 * `POST /post` 를 처리한 인스턴스와 `GET /fetch` 를 처리한 인스턴스가 다르면
 * 봉투가 사라진다. 테스트는 통과하는데 실제로는 메시지가 없어지는 고장이다.
 *
 * HTTP REST 를 쓰는 이유는 서버리스 함수가 TCP 커넥션을 재활용하지 못해
 * 금방 고갈되기 때문이다. Upstash 의 REST 는 그 제약을 위해 존재한다.
 *
 * 여기서 지키는 두 가지:
 *
 *   - **드레인은 `LPOP key count` 한 번**이다. `LRANGE` + `LTRIM` 조합은
 *     읽은 것과 지우는 것이 어긋날 수 있다 — 읽는 쪽 끝으로 push 가 들어오면
 *     읽지 않은 항목을 잘라낸다. 한 명령이면 그 질문 자체가 없다.
 *   - **push 마다 `EXPIRE` 를 다시 건다.** Redis 는 `LPUSH` 로 TTL 이
 *     갱신되지 않는다(공식 문서: 리스트에 값을 넣는 것은 timeout 을 건드리지
 *     않는다). 다시 걸지 않으면 활발한 큐가 7일 뒤 통째로 사라진다.
 */
import type { Store, Stored } from './store.js'
import { DEFAULT_TTL_MS, DEFAULT_MAX_QUEUE } from './store.js'

/** Upstash REST 응답. 성공이면 `result`, 실패면 `error` 다. */
interface RestResponse {
  readonly result?: unknown
  readonly error?: string
}

export interface UpstashStoreOptions {
  /** `UPSTASH_REDIS_REST_URL`. */
  readonly url: string
  /** `UPSTASH_REDIS_REST_TOKEN`. */
  readonly token: string
  readonly ttlMs?: number
  /** 수신자당 큐 상한. 무한 적재를 막는다. */
  readonly maxQueue?: number
  /** 키 접두. 한 DB 를 다른 용도와 나눠 쓸 때 구분한다. */
  readonly prefix?: string
  /** 테스트에서 주입한다. 기본은 전역 `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

export class UpstashError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UpstashError'
  }
}

/**
 * Upstash Redis 저장소.
 *
 * 봉투는 base64 로 담는다. REST 는 JSON 이라 원시 바이트를 그대로 실을 수 없다.
 */
export class UpstashStore implements Store {
  private readonly base: string
  private readonly token: string
  private readonly ttlSeconds: number
  private readonly maxQueue: number
  private readonly prefix: string
  private readonly http: typeof globalThis.fetch

  constructor(options: UpstashStoreOptions) {
    if (!options.url) throw new UpstashError('UPSTASH_REDIS_REST_URL 이 비어 있다')
    if (!options.token) throw new UpstashError('UPSTASH_REDIS_REST_TOKEN 이 비어 있다')
    this.base = options.url.replace(/\/+$/, '')
    this.token = options.token
    // Redis EXPIRE 는 초 단위다. 올림해서 TTL 이 의도보다 짧아지지 않게 한다.
    this.ttlSeconds = Math.max(1, Math.ceil((options.ttlMs ?? DEFAULT_TTL_MS) / 1000))
    // 기본값을 여기 다시 적지 않는다 — 메모리 저장소와 갈리면 같은 릴레이가
    // 저장소에 따라 다른 상한을 갖게 되고, 그 차이는 배포한 뒤에야 드러난다.
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
    this.prefix = options.prefix ?? 'acm:q:'
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * 큐에 넣는다.
   *
   * 세 명령을 원자적으로 묶는다:
   *   RPUSH  — 뒤에 넣는다(LPOP 이 앞에서 꺼내므로 FIFO 가 된다)
   *   LTRIM  — 상한을 넘으면 오래된 것부터 버린다
   *   EXPIRE — TTL 을 다시 건다 (RPUSH 는 TTL 을 갱신하지 않는다)
   *
   * 원자적으로 묶는 이유는 중간 상태가 남지 않게 하기 위함이다 — RPUSH 만
   * 되고 EXPIRE 가 실패하면 그 큐는 영원히 남는다.
   */
  async push(recipient: string, item: Stored): Promise<void> {
    const key = this.key(recipient)
    const payload = encode(item)
    await this.exec([
      ['RPUSH', key, payload],
      // 뒤에서 넣으므로 최근 maxQueue 개만 남긴다. 오래된 것을 버리는 이유는
      // 새 메시지를 거부하면 활발한 채널이 죽은 큐 하나 때문에 막혀서다.
      ['LTRIM', key, String(-this.maxQueue), '-1'],
      ['EXPIRE', key, String(this.ttlSeconds)],
    ])
  }

  /**
   * 큐를 비우며 꺼낸다.
   *
   * `LPOP key count` 한 번이다 — 읽기와 삭제가 한 명령이라 그 사이에
   * 끼어들 틈이 없다. 마지막 항목을 꺼내면 Redis 가 키를 지우고 TTL 도
   * 같이 사라지는데, 다음 push 가 EXPIRE 를 다시 걸므로 문제되지 않는다.
   */
  async drain(recipient: string, limit: number): Promise<Stored[]> {
    if (limit <= 0) return []
    const raw = await this.command(['LPOP', this.key(recipient), String(limit)])
    // 큐가 비어 있으면 null 이다. 빈 배열과 구분해 다룰 이유는 없다.
    if (raw === null || raw === undefined) return []
    if (!Array.isArray(raw)) {
      throw new UpstashError(`LPOP 이 배열이 아닌 것을 돌려줬다: ${typeof raw}`)
    }
    return raw.map(decodeItem)
  }

  async depth(recipient: string): Promise<number> {
    const raw = await this.command(['LLEN', this.key(recipient)])
    return typeof raw === 'number' ? raw : 0
  }

  private key(recipient: string): string {
    return this.prefix + recipient
  }

  /** 명령 하나. */
  private async command(args: readonly string[]): Promise<unknown> {
    const body = await this.request('', args)
    if (Array.isArray(body)) throw new UpstashError('단일 명령에 배열 응답이 왔다')
    const one = body as RestResponse
    if (one.error) throw new UpstashError(one.error)
    return one.result
  }

  /** 여러 명령을 원자적으로. 하나라도 실패하면 전부 버려진다. */
  private async exec(commands: readonly (readonly string[])[]): Promise<void> {
    const body = await this.request('/multi-exec', commands)
    if (!Array.isArray(body)) {
      const one = body as RestResponse
      throw new UpstashError(one.error ?? 'multi-exec 응답이 배열이 아니다')
    }
    for (const entry of body as RestResponse[]) {
      if (entry.error) throw new UpstashError(entry.error)
    }
  }

  private async request(path: string, payload: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.http(this.base + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    } catch (e) {
      // 네트워크 실패를 조용히 삼키지 않는다 — 봉투가 사라지는 것보다
      // 발신자가 실패를 아는 편이 낫다.
      throw new UpstashError(`Upstash 에 닿지 못했다: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      throw new UpstashError(
        `Upstash 가 오류를 돌려줬다 — 상태 ${res.status}: ${await res.text()}`,
        res.status,
      )
    }
    return await res.json()
  }
}

/**
 * 저장 형식. 도착 시각을 봉투와 함께 담는다.
 *
 * `receivedAt` 이 필요한 이유는 순서 복원 때문이다(§10.7). Redis 리스트가
 * 순서를 지키지만, 그 값을 클라이언트에 그대로 돌려줘야 한다.
 */
function encode(item: Stored): string {
  return `${item.receivedAt}:${base64(item.envelope)}`
}

function decodeItem(raw: unknown): Stored {
  if (typeof raw !== 'string') {
    throw new UpstashError(`큐 항목이 문자열이 아니다: ${typeof raw}`)
  }
  const at = raw.indexOf(':')
  if (at < 0) throw new UpstashError('큐 항목 형식이 어긋난다 — 구분자가 없다')
  const receivedAt = Number(raw.slice(0, at))
  if (!Number.isFinite(receivedAt)) {
    throw new UpstashError('큐 항목의 도착 시각이 숫자가 아니다')
  }
  return { receivedAt, envelope: fromBase64(raw.slice(at + 1)) }
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

/** 환경변수로 저장소를 만든다. 자격이 없으면 던진다. */
export function fromEnv(env: Record<string, string | undefined>, options: Partial<UpstashStoreOptions> = {}): UpstashStore {
  const { url, token } = credentials(env)
  if (!url || !token) {
    throw new UpstashError(
      'Upstash 자격이 없다 — UPSTASH_REDIS_REST_URL 과 UPSTASH_REDIS_REST_TOKEN 을 설정한다. ' +
        '(Vercel 통합이 KV_REST_API_URL/TOKEN 으로 넣었다면 그것도 읽는다.)',
    )
  }
  return new UpstashStore({ ...options, url, token })
}

/**
 * 자격이 있는지만 본다 — 저장소를 만들지 않는다.
 *
 * 진입점이 "Upstash 냐 메모리냐"를 고를 때 쓴다. 환경변수 이름을 아는 곳을
 * 여기 하나로 둔다 — 진입점이 같은 이름을 따로 읽으면 별칭이 하나 늘 때마다
 * 두 곳이 어긋나고, 그 어긋남은 "자격이 있는데 메모리를 골랐다"처럼
 * 조용히 봉투를 버리는 형태로 나타난다.
 */
export function hasUpstashCredentials(env: Record<string, string | undefined>): boolean {
  const { url, token } = credentials(env)
  return Boolean(url && token)
}

/**
 * Vercel 의 Upstash 통합이 넣어 주는 이름이 프로젝트마다 다를 수 있어
 * 두 관례를 모두 본다 — 최신 `UPSTASH_*` 와 레거시 `KV_*`.
 */
function credentials(env: Record<string, string | undefined>): {
  url: string | undefined
  token: string | undefined
} {
  return {
    url: env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN,
  }
}
