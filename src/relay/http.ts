/**
 * 릴레이 HTTP 계층 — 얇게 유지한다
 *
 * 라우팅 로직은 `Relay` 가 갖고, 여기는 HTTP 를 그 호출로 옮기기만 한다.
 * 그래야 릴레이 로직 테스트에 HTTP 가 필요 없다.
 *
 * 표준 `Request`/`Response` 만 쓰므로 `Bun.serve()` 와 서버리스 함수
 * (Vercel·Cloudflare) 양쪽에 같은 핸들러가 올라간다.
 */
import { Relay, type RelayOptions } from './relay.js'
import {
  parseFetchAuth,
  verifyFetchAuth,
  HEADER_KEM,
  HEADER_SIGN,
  HEADER_SIG,
  HEADER_TIME,
  HEADER_NONCE,
} from './fetch-auth.js'
import { verifyPostAuth, type PostAuth } from './post-auth.js'

/** 조회에 필요한 헤더 목록. 이름은 `fetch-auth` 가 단일 정의한다. */
const AUTH_HEADERS = [HEADER_KEM, HEADER_SIGN, HEADER_SIG, HEADER_TIME, HEADER_NONCE].join(', ')

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
  /**
   * 쓰기 정책 (§10.13). **선택 항목이 아니다.**
   *
   * 기본값을 두면 그 기본값이 곧 이 릴레이의 보안이 되고, 호출자는 자기가
   * 무엇을 고른 적 없다는 사실조차 모른다. 열어 두는 것도 고르는 것이다 —
   * `{ open: true }` 라고 적게 한다. `selectPostAuth` 가 그 판단을 갖는다.
   */
  readonly postAuth: PostAuth
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
 * `/fetch` 는 서명으로 인증한다 (§10.12). 요청이 두 공개키와 서명을 함께
 * 싣고, 릴레이는 key id 를 그 공개키에서 다시 파생해 대조한 뒤 서명을 본다 —
 * 저장하는 매핑이 없으므로 무상태가 유지된다. 남는 한계는 둘이다.
 *
 * - 시간 창(`FETCH_WINDOW_MS`) 안에 캡처된 요청은 재생될 수 있다. 릴레이가
 *   무상태라 이미 본 nonce 를 기억하지 못한다.
 * - 인증이 서명 공개키를 릴레이에 넘기므로 릴레이는 §9 지문을 계산할 수 있다.
 *   메시지 내용에는 여전히 닿지 못한다.
 *
 * `POST /post` 는 배포 단위의 공유 토큰으로 인증한다 (§10.13). 여기서 물을
 * 수 있는 것은 "이 릴레이를 쓸 자격이 있는가" 뿐이다 — 채널 멤버십은 종단 간
 * 사실이라 릴레이가 판단할 근거가 없다(§5.1·§8). 그 한 겹이 필요한 이유는
 * 큐가 상한에서 **가장 오래된 것부터 버리기** 때문이다: 아무나 쓸 수 있으면
 * 남의 key id 로 큐를 채우는 것만으로 아직 못 받은 봉투를 밀어낼 수 있고,
 * 당한 쪽에는 그 유실이 보이지 않는다 (`post-auth.ts`).
 */
export function createHandler(options: HttpOptions): (req: Request) => Promise<Response> {
  const relay = new Relay(options)
  const fetchLimit = options.fetchLimit
  const postAuth = options.postAuth

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && path === '/health') {
      return json<HealthBody>({ ok: true })
    }

    if (req.method === 'POST' && path === '/post') {
      // 본문을 읽기 **전에** 끝낸다. 통과하지 못한 요청에는 저장소도, 파싱도,
      // 최대 1MB 짜리 본문을 메모리로 끌어오는 일도 없어야 한다 — 인증을
      // 나중에 하면 그 앞 단계가 전부 무료 공격면이 된다.
      const allowed = verifyPostAuth(postAuth, req.headers)
      if (!allowed.ok) {
        return json<ErrorBody>({ ok: false, reason: allowed.reason, detail: allowed.detail }, 401)
      }

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

      // 인증은 저장소를 건드리기 **전에** 끝난다. 그래서 통과하지 못한 쪽은
      // 그 key id 의 큐가 존재하는지조차 알 수 없고(응답이 큐 상태에 의존하지
      // 않는다), 무엇보다 큐가 비워지지 않는다 — 드레인은 검증을 통과한
      // 요청만 한다 (`docs/architecture.md` §10.12). 실패를 빈 배열로 답하면
      // 호출자는 "메시지가 없다" 와 "인증이 틀렸다" 를 구분하지 못한 채
      // 영영 못 받는 상태를 정상으로 오해한다.
      //
      // 상수시간 비교가 필요 없다. 여기서 견주는 값은 경로의 key id, 두 공개키,
      // 서명뿐이고 전부 공개값이다 — 비밀이 개입하지 않으므로 비교 시간이
      // 새어도 공격자가 알게 되는 것이 없다(이미 아는 값이다).
      const auth = parseFetchAuth(req.headers)
      if (!auth) {
        return json<ErrorBody>(
          {
            ok: false,
            reason: 'missing-auth',
            detail: `조회에는 인증 헤더가 필요하다: ${AUTH_HEADERS} (§10.12)`,
          },
          401,
        )
      }
      const verified = verifyFetchAuth(keyId, auth, Date.now())
      if (!verified.ok) {
        return json<ErrorBody>(
          { ok: false, reason: verified.reason, detail: verified.detail },
          401,
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
