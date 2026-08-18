/**
 * 쓰기 인증 — 이 릴레이를 **누가 쓸 수 있는가**
 *
 * 설계 근거는 docs/architecture.md §10.13.
 *
 * `/fetch` 인증(§10.12)과 목적이 다르다. 저쪽은 "이 수신함이 네 것인가" 를
 * 묻고, 답은 요청 안에 다 들어 있다 — key id 를 공개키에서 다시 파생해
 * 대조하면 되므로 릴레이가 아무것도 기억할 필요가 없다. 쓰기에는 그런 질문이
 * 없다. **봉투를 넣는 데 필요한 신원 같은 것이 원래 없기 때문이다** — 채널
 * 멤버십은 종단 간 사실이고(§8 신뢰 목록은 브릿지에 있다), 릴레이는 조회할
 * 테이블이 없다(§5.1). 여기서 물을 수 있는 것은 하나뿐이다: **이 릴레이를 쓰라고
 * 허락받은 쪽인가.**
 *
 * 그래서 채널별이 아니라 **배포 단위**의 공유 비밀 하나다. 채널 접근 통제를
 * 대신하지 않는다 — 토큰을 가진 쪽은 여전히 아무 채널로도 봉투를 밀어 넣을 수
 * 있고, 그걸 막는 것은 §8 의 수신자 검증이다. 이 문이 막는 것은 그 아래층,
 * **릴레이 자체의 남용**이다.
 *
 * 남용이 실제로 무엇을 부수는지가 이 파일이 존재하는 이유다. `MemoryStore` 도
 * Upstash 도 큐가 `maxQueue` 를 넘으면 **가장 오래된 것부터 버린다**. 즉 아무나
 * 쓸 수 있는 릴레이에서는 남의 key id 로 쓰레기를 1000건 밀어 넣는 것만으로
 * 그 사람이 아직 못 받은 진짜 메시지를 밀어낼 수 있다. 봉투는 열리지 않지만
 * 사라지고, 보낸 쪽은 200 을 받았으므로 아무도 눈치채지 못한다. 기밀성이 아니라
 * **가용성**이 걸린 문제이며, 조용한 유실은 이 프로젝트가 가장 싫어하는 실패다.
 *
 * 서명으로 대신할 수 없다. 공격자도 키쌍을 얼마든지 만들 수 있으므로 "서명이
 * 붙어 있다" 는 통제가 되지 못하고, 대신 발신자의 서명 공개키를 릴레이에
 * 넘겨 §10.8 의 메타데이터 노출만 넓힌다.
 */
import { sha256 } from '@noble/hashes/sha2.js'

/** 토큰을 싣는 헤더. 표준 형식을 그대로 쓴다 — `Authorization: Bearer <토큰>`. */
export const HEADER_POST_AUTH = 'Authorization'

/**
 * 토큰 최소 길이.
 *
 * 이 값이 있는 이유는 짧은 토큰이 **인증이 있다는 착각만 주기** 때문이다.
 * 릴레이는 온라인 추측을 늦추는 장치가 없고(무상태라 시도 횟수를 셀 수 없다),
 * `openssl rand -hex 32` 가 64자를 주므로 32자는 넉넉한 하한이다.
 */
export const MIN_TOKEN_CHARS = 32

/**
 * 쓰기 정책. **둘 중 하나를 반드시 고른다** — 기본값이 없다.
 *
 * `--delivery` 와 같은 이유다(CLAUDE.md). 환경을 보고 짐작한 값이 틀리면
 * "동작하는 것처럼 보이는 고장" 이 되고, 여기서 그 고장은 열린 릴레이다.
 */
export type PostAuth = { readonly token: string } | { readonly open: true }

export type PostAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly detail: string }

/** `Authorization: Bearer <토큰>` 에서 토큰만 꺼낸다. 없거나 다른 방식이면 `undefined`. */
export function parseBearer(headers: Headers): string | undefined {
  const raw = headers.get(HEADER_POST_AUTH)
  if (raw === null) return undefined
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim())
  return m?.[1]
}

/**
 * 토큰을 검사한다.
 *
 * **상수시간으로 견준다.** `/fetch` 와 정반대 상황이다 — 저기서 견주는 값은
 * 전부 공개값이라 비교 시간이 새어도 잃을 것이 없지만(그 파일 주석 참고),
 * 여기 견주는 값은 비밀이다. 앞에서부터 한 글자씩 맞춰 보는 비교는 맞은
 * 글자 수만큼 오래 걸리므로, 그 시간차를 재면서 한 글자씩 늘려 가면 토큰
 * 전체를 복원할 수 있다.
 *
 * 먼저 해시한 뒤 견주는 이유는 **길이까지 감추기** 위해서다. 바이트를 바로
 * 비교하면 길이가 다른 순간 짧게 끝나 길이가 새고, 길이를 알면 추측 공간이
 * 그만큼 줄어든다. sha256 은 무엇을 넣든 32바이트를 내놓는다.
 */
export function verifyPostAuth(auth: PostAuth, headers: Headers): PostAuthResult {
  if ('open' in auth) return { ok: true }

  const given = parseBearer(headers)
  if (given === undefined) {
    return {
      ok: false,
      reason: 'missing-auth',
      detail: `봉투를 올리려면 ${HEADER_POST_AUTH}: Bearer <토큰> 이 필요하다 (§10.13)`,
    }
  }
  if (!constantTimeEqual(given, auth.token)) {
    return { ok: false, reason: 'bad-token', detail: '토큰이 맞지 않는다' }
  }
  return { ok: true }
}

/** 두 문자열이 같은가 — 걸리는 시간이 내용에 의존하지 않는다. */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = sha256(new TextEncoder().encode(a))
  const hb = sha256(new TextEncoder().encode(b))
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!
  return diff === 0
}

export interface PostAuthContext {
  /** 서버리스인가. 배포판은 주소를 우리가 정하지 못하므로 열린 채로 뜨면 곧 공개다. */
  readonly serverless: boolean
  /** 묶을 주소. 루프백이면 이 기계 밖에서 닿지 못한다. */
  readonly host: string
}

/**
 * 환경에서 쓰기 정책을 정한다. `selectStore` 와 같은 자리·같은 태도다.
 *
 *   토큰 있음                      → 강제
 *   토큰 없음 + 루프백             → 열림 (이 기계 밖에서 닿지 못한다)
 *   토큰 없음 + 공개 주소·서버리스 → 던진다
 *
 * 셋째가 이 함수의 존재 이유다. 열린 릴레이를 공개 주소에 띄우는 것은 위
 * 파일 주석의 큐 밀어내기를 아무에게나 허용하는 것이고, 그 피해는 **당한
 * 쪽에서도 보이지 않는다**(못 받은 메시지는 화면에 나타나지 않는다). 기동
 * 때 크게 죽는 편이 낫다 — `selectStore` 가 봉투 유실 앞에서 내린 것과 같은
 * 판단이다.
 *
 * 여기에 "그래도 열겠다" 는 탈출구를 두지 않는다. 그런 플래그는 곧 복붙되는
 * 기본값이 되고, 그러면 이 검사는 있으나 마나다. 공개 주소에 띄우고 싶으면
 * 토큰을 만든다 — 명령 한 줄이다.
 */
export function selectPostAuth(
  env: Record<string, string | undefined>,
  context: PostAuthContext,
): PostAuth {
  const token = env.ACM_RELAY_TOKEN?.trim()
  if (token !== undefined && token !== '') {
    if (token.length < MIN_TOKEN_CHARS) {
      throw new Error(
        `ACM_RELAY_TOKEN 이 너무 짧다 (${String(token.length)}자, 최소 ${String(MIN_TOKEN_CHARS)}자). ` +
          '짧은 토큰은 인증이 있다는 착각만 준다 — `openssl rand -hex 32` 로 만든다.',
      )
    }
    return { token }
  }

  if (context.serverless || !isLoopback(context.host)) {
    throw new Error(
      '쓰기 인증 없이 공개 주소에 뜨지 않는다 — 누구나 남의 수신함에 봉투를 밀어 넣어 ' +
        '아직 못 받은 메시지를 큐 밖으로 밀어낼 수 있고, 당한 쪽에서는 그 유실이 보이지 않는다. ' +
        'ACM_RELAY_TOKEN 을 설정한다 (`openssl rand -hex 32`). ' +
        '인증 없이 띄우려면 루프백(--host 127.0.0.1)으로만 띄운다.',
    )
  }
  return { open: true }
}

/**
 * 이 기계 밖에서 닿지 못하는 주소인가.
 *
 * 넓게 잡지 않는다. 사설 대역(10./192.168.)은 루프백이 아니다 — 같은 망의
 * 다른 기계가 닿을 수 있고, "우리 망이니 괜찮다" 는 판단은 릴레이가 아니라
 * 사용자가 할 몫이다(그 경우에도 토큰을 만들면 된다).
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}
