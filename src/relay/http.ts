/**
 * 릴레이 HTTP 계층 — 얇게 유지한다
 *
 * 라우팅 로직은 `Relay` 가 갖고, 여기는 HTTP 를 그 호출로 옮기기만 한다.
 * 그래야 릴레이 로직 테스트에 HTTP 가 필요 없다.
 *
 * 표준 `Request`/`Response` 만 쓰므로 `Bun.serve()` 와 서버리스 함수
 * (Vercel·Cloudflare) 양쪽에 같은 핸들러가 올라간다.
 */
import { Relay, type RelayOptions } from './relay.ts'

/** key id hex 8바이트 = 16자. 경로에서 받는 값이라 형태를 검증한다. */
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/i

/** 실패 응답. 모든 경로가 같은 모양을 쓴다. */
export interface ErrorBody {
  readonly ok: false
  readonly reason: string
  readonly detail: string
}

/** `POST /post` 성공 응답. */
export interface PostBody {
  readonly ok: true
  readonly recipients: number
  readonly messageId: string
}

/** `GET /fetch/<key id>` 성공 응답. 봉투는 base64 다. */
export interface FetchBody {
  readonly ok: true
  readonly messages: readonly { readonly envelope: string; readonly receivedAt: number }[]
}

export interface HealthBody {
  readonly ok: true
}

export interface HttpOptions extends RelayOptions {
  /** 폴링 한 번에 돌려줄 최대 개수. */
  readonly fetchLimit?: number
}

/**
 * HTTP 핸들러를 만든다.
 *
 * ```
 * POST /post              봉투 바이트 (application/octet-stream)
 * GET  /fetch/<key id>    수신함을 비우며 가져간다
 * GET  /health            상태 확인
 * ```
 *
 * `/fetch` 에 인증이 없다 — key id 만 알면 남의 큐를 비울 수 있다.
 * 읽지는 못하지만 전달을 막을 수 있다. 알려진 v1 한계이며 근거와
 * 대안은 `docs/architecture.md` §10.12.
 */
export function createHandler(options: HttpOptions): (req: Request) => Promise<Response> {
  const relay = new Relay(options)
  const fetchLimit = options.fetchLimit

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && path === '/health') {
      return json<HealthBody>({ ok: true })
    }

    if (req.method === 'POST' && path === '/post') {
      const body = new Uint8Array(await req.arrayBuffer())
      const result = await relay.post(body)
      if (!result.ok) {
        // 형식 오류는 400, 크기 초과는 413 — 클라이언트가 구분해 대응한다.
        const status = result.reason === 'too-large' ? 413 : 400
        return json<ErrorBody>({ ok: false, reason: result.reason, detail: result.detail }, status)
      }
      return json<PostBody>({
        ok: true,
        recipients: result.recipients,
        messageId: result.messageId,
      })
    }

    const fetching = path.match(/^\/fetch\/([^/]+)$/)
    if (req.method === 'GET' && fetching) {
      const keyId = fetching[1]!
      if (!KEY_ID_PATTERN.test(keyId)) {
        return json<ErrorBody>(
          { ok: false, reason: 'bad-key-id', detail: 'key id 는 hex 16자여야 한다' },
          400,
        )
      }
      const items = await relay.fetch(keyId, fetchLimit)
      // 봉투는 바이너리다. JSON 에 담기 위해 base64 로 옮긴다.
      return json<FetchBody>({
        ok: true,
        messages: items.map(i => ({
          envelope: base64(i.envelope),
          receivedAt: i.receivedAt,
        })),
      })
    }

    return json<ErrorBody>(
      { ok: false, reason: 'not-found', detail: `${req.method} ${path}` },
      404,
    )
  }
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** base64 를 바이트로. 클라이언트 쪽에서 쓴다. */
export function fromBase64(text: string): Uint8Array {
  const raw = atob(text)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}
