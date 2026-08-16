/**
 * 서명된 수신함 폴링의 서명 대상·헤더 규약 (§10.12)
 *
 * 릴레이(검증)와 클라이언트(서명)가 **같은 함수**를 쓴다. 양쪽이 각자
 * 바이트를 조립하면 언젠가 순서나 길이가 갈리고, 그 고장은 "서명이 항상
 * 실패한다" 는 형태로만 보여 원인이 암호 쪽에 있는 것처럼 보인다.
 *
 * 이 모듈이 정직하게 밝혀 둘 것 두 가지.
 *
 * 1. **nonce 는 재전송 방지가 아니다.** 릴레이는 무상태라(§10.7) 이미 본
 *    nonce 를 기억할 수 없다. 그래서 시간 창 안에 캡처된 요청은 그대로
 *    재생된다. 실제 재전송 경계는 `FETCH_WINDOW_MS` 이고, nonce 는 같은
 *    밀리초에 두 번 서명해도 서명 바이트가 겹치지 않게 하는 용도다.
 * 2. **이 인증은 릴레이에게 서명 공개키를 넘긴다.** 따라서 릴레이는 §9 지문
 *    (`sha256(sha256(signPub))[0..16]`)을 계산할 수 있다 — key id 만 보던
 *    때보다 릴레이가 아는 것이 늘어난다. 서명 기반 폴링 인증의 고유 비용이며,
 *    메시지 내용에는 닿지 못하지만 숨길 일도 아니다.
 */
import { KEY_ID_BYTES, keyIdOf, verify } from '../identity/verify.js'

/** 서명 도메인 라벨. 12바이트 고정. */
export const FETCH_LABEL = new TextEncoder().encode('acm/v1/fetch')

/** 서명이 유효한 시간 창. 이 값이 실제 재전송 경계다(위 doc-comment 1번). */
export const FETCH_WINDOW_MS = 5 * 60_000

export const FETCH_NONCE_BYTES = 16

/** 헤더 이름. 릴레이·클라이언트가 문자열을 따로 적지 않도록 여기서만 정의한다. */
export const HEADER_KEM = 'X-ACM-Kem'
export const HEADER_SIGN = 'X-ACM-Sign'
export const HEADER_SIG = 'X-ACM-Sig'
export const HEADER_TIME = 'X-ACM-Time'
export const HEADER_NONCE = 'X-ACM-Nonce'

const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64

/**
 * 서명 대상 바이트. `docs/architecture.md` §10.12 가 정한 순서 그대로다.
 *
 * ```
 * FETCH_LABEL(12B) ‖ keyId(8B) ‖ timeMs(8B big-endian uint64) ‖ nonce(16B)   = 44B
 * ```
 *
 * **길이 접두를 넣지 않는다** — 네 필드가 전부 고정 길이라 이어붙이기에
 * 모호성이 없다. 다른 (keyId, timeMs, nonce) 조합이 같은 44바이트로 접힐 수
 * 없으므로, 길이 접두가 막아 줄 혼동 자체가 존재하지 않는다. 대신 입력 길이를
 * 여기서 강제한다 — 고정 길이 가정이 깨지면 그 순간 이 논증도 깨진다.
 *
 * **요청 URL 을 서명 대상에 넣지 않는다** (`docs/architecture.md` §10.12).
 * 경로·쿼리스트링은 배포 인프라가 바꿀 수 있는 값이라, URL 을 서명하면
 * 클라이언트와 릴레이가 서로 다른 바이트를 서명하게 된다. 그 고장은 변형
 * 계층이 없는 로컬 테스트에서 재현되지 않고 배포에서만 나타난다.
 *
 * key id 자체는 여전히 서명된다 — URL 이 아니라 바이트로 넣기 때문에 인프라가
 * 손댈 수 없고, 그래서 "이 서명은 이 큐를 향한다" 는 결속이 유지된다.
 */
export function fetchSigningBytes(
  keyId: Uint8Array,
  timeMs: number,
  nonce: Uint8Array,
): Uint8Array {
  if (keyId.length !== KEY_ID_BYTES) {
    throw new Error(`key id 길이는 ${KEY_ID_BYTES}바이트여야 한다 (받은 값: ${keyId.length})`)
  }
  if (nonce.length !== FETCH_NONCE_BYTES) {
    throw new Error(`nonce 길이는 ${FETCH_NONCE_BYTES}바이트여야 한다 (받은 값: ${nonce.length})`)
  }
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
    throw new Error(`timeMs 값은 음수가 아닌 안전한 정수여야 한다 (받은 값: ${timeMs})`)
  }

  const out = new Uint8Array(FETCH_LABEL.length + keyId.length + 8 + nonce.length)
  let at = 0
  out.set(FETCH_LABEL, at)
  at += FETCH_LABEL.length
  out.set(keyId, at)
  at += keyId.length
  new DataView(out.buffer, out.byteOffset + at, 8).setBigUint64(0, BigInt(timeMs))
  at += 8
  out.set(nonce, at)
  return out
}

/** 요청이 싣고 오는 인증 재료. 전부 공개값이다 — 개인키는 서명 안에만 남는다. */
export interface FetchAuth {
  readonly kemPublicKey: Uint8Array
  readonly signPublicKey: Uint8Array
  readonly signature: Uint8Array
  readonly timeMs: number
  readonly nonce: Uint8Array
}

/** 새 nonce. 서명 유일성 확보용이라 CSPRNG 로 뽑는다. */
export function newFetchNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(FETCH_NONCE_BYTES))
}

/** 인증 재료를 헤더 5개로 편다. */
export function fetchAuthHeaders(auth: FetchAuth): Record<string, string> {
  return {
    [HEADER_KEM]: hex(auth.kemPublicKey),
    [HEADER_SIGN]: hex(auth.signPublicKey),
    [HEADER_SIG]: hex(auth.signature),
    [HEADER_TIME]: String(auth.timeMs),
    [HEADER_NONCE]: hex(auth.nonce),
  }
}

/**
 * 헤더를 인증 재료로 되돌린다. 형태가 하나라도 어긋나면 `null`.
 *
 * 여기서는 **형태만** 본다. 암호적 판단은 전부 `verifyFetchAuth` 가 한다 —
 * 파싱이 검증을 겸하면 "왜 거부됐는지" 가 두 곳으로 흩어진다.
 */
export function parseFetchAuth(headers: Headers): FetchAuth | null {
  const kemPublicKey = fromHex(headers.get(HEADER_KEM), PUBLIC_KEY_BYTES)
  const signPublicKey = fromHex(headers.get(HEADER_SIGN), PUBLIC_KEY_BYTES)
  const signature = fromHex(headers.get(HEADER_SIG), SIGNATURE_BYTES)
  const nonce = fromHex(headers.get(HEADER_NONCE), FETCH_NONCE_BYTES)
  if (!kemPublicKey || !signPublicKey || !signature || !nonce) return null

  const rawTime = headers.get(HEADER_TIME)
  if (rawTime === null || !/^[0-9]+$/.test(rawTime)) return null
  const timeMs = Number(rawTime)
  if (!Number.isSafeInteger(timeMs)) return null

  return { kemPublicKey, signPublicKey, signature, timeMs, nonce }
}

export type FetchAuthResult = { ok: true } | { ok: false; reason: string; detail: string }

/**
 * 경로의 key id 에 대해 인증 재료를 검증한다.
 *
 * 검사 순서는 비용이 아니라 의미로 정했다 — 뒤 단계가 앞 단계의 결론에
 * 의존한다. 서명을 먼저 봐도 "누구의 서명인지" 를 모르면 아무 의미가 없다.
 */
export function verifyFetchAuth(
  keyIdHex: string,
  auth: FetchAuth,
  nowMs: number,
): FetchAuthResult {
  // 1. 시각 창. 양방향으로 본다 — 클라이언트 시계가 앞선 경우도 스큐이지
  //    공격이 아니다. 이 창이 재전송의 실제 경계다(모듈 doc-comment 1번).
  const skew = Math.abs(nowMs - auth.timeMs)
  if (skew > FETCH_WINDOW_MS) {
    return {
      ok: false,
      reason: 'stale-request',
      detail: `요청 시각이 창(${FETCH_WINDOW_MS}ms) 밖이다 (차이: ${skew}ms)`,
    }
  }

  // 2. 소유권. 제시된 두 공개키에서 key id 를 다시 계산해 경로의 것과 맞춘다.
  //    이것이 "이 서명키가 이 큐의 주인 것" 임을 증명한다 — 이 검사가 없으면
  //    피해자의 KEM 공개키에 공격자의 서명키를 붙인 요청이 그대로 통과한다
  //    (§10.12). 릴레이는 아무것도 저장하지 않고 계산만으로 확인한다.
  const keyId = keyIdOf(auth.kemPublicKey, auth.signPublicKey)
  const derived = hex(keyId)
  if (derived !== keyIdHex.toLowerCase()) {
    return {
      ok: false,
      reason: 'key-id-mismatch',
      detail: `제시된 공개키가 파생하는 key id 다: ${derived}`,
    }
  }

  // 3. 서명. 여기까지 왔으면 서명키가 큐 주인의 것임은 확정됐으므로,
  //    서명 검증이 곧 "주인이 이 요청을 만들었다" 가 된다.
  //    서명 대상의 key id 는 경로 문자열이 아니라 방금 파생한 바이트를 쓴다 —
  //    둘은 위에서 동일함이 확인됐고, 파싱을 한 번 더 하지 않는 쪽이 안전하다.
  const message = fetchSigningBytes(keyId, auth.timeMs, auth.nonce)
  if (!verify(auth.signPublicKey, message, auth.signature)) {
    return { ok: false, reason: 'bad-signature', detail: '서명이 서명 대상과 맞지 않는다' }
  }

  return { ok: true }
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** 길이가 정확히 `bytes` 인 hex 만 받는다. 그 외에는 전부 `null`. */
function fromHex(text: string | null, bytes: number): Uint8Array | null {
  if (text === null || text.length !== bytes * 2) return null
  if (!/^[0-9a-f]+$/i.test(text)) return null
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}
