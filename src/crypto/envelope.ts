/**
 * 봉투 — 평문 헤더 + 수신자별 래핑 키 + 암호화 본문 + 발신자 서명
 *
 * 설계 근거는 docs/architecture.md §10.6 (평문 봉투) · §10.3 (팬아웃).
 *
 * 평문 헤더는 릴레이가 라우팅에 쓰는 최소한이며, 그 전부가 AEAD 의 AAD 에
 * 결속된다 — 헤더를 한 비트라도 고치면 복호화가 깨진다. 권고가 아니라
 * 암호학적 결속이다 (§10.5).
 */

export const MAGIC = 0x414d4831 // "AMH1" — agent-channel-mesh v1
export const CHANNEL_TAG_BYTES = 16
export const MESSAGE_ID_BYTES = 16
export const KEY_ID_BYTES = 8
export const NONCE_BYTES = 24 // XChaCha20 — 랜덤 생성해도 안전한 192비트
export const SIGNATURE_BYTES = 64
export const WRAPPED_KEY_BYTES = 80 // HPKE enc 32 + 콘텐츠 키 32 + 태그 16

/** 헤더 고정부 — magic 4 + 나머지 (§10.6 표) */
const HEADER_FIXED_BYTES =
  4 + CHANNEL_TAG_BYTES + MESSAGE_ID_BYTES + KEY_ID_BYTES + 8 + 8 + NONCE_BYTES

/** 봉투가 커버하는 최대 크기. 릴레이·메모리 폭주를 막는 상한. */
export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_RECIPIENTS = 256

/** 수신자 한 명분 래핑 키 */
export interface WrappedKey {
  /** 수신자 KEM 공개키의 key id (8B) — 어느 것을 풀지 고르는 용도 */
  readonly keyId: Uint8Array
  /** HPKE enc(32B) + 봉인된 콘텐츠 키(48B) */
  readonly wrapped: Uint8Array
}

/**
 * 봉투 평문 헤더. 전부 릴레이에 보이며, 전부 AAD 에 결속된다.
 *
 * 유출되는 것은 §10.6 표에 정직하게 적혀 있다 — 소셜 그래프, 활동 패턴,
 * 그룹 크기, 메시지 길이. 내용은 유출되지 않는다.
 */
export interface Header {
  /** 채널 식별 16B. v1 에서 회전 태그로 갈 자리 (§10.6) */
  readonly channelTag: Uint8Array
  /** dedup 용 발신자 부여 id 16B. 내용 주소가 아니다 (§10.5) */
  readonly messageId: Uint8Array
  /** 발신자 KEM key id 8B */
  readonly senderKeyId: Uint8Array
  /** 발신자별 단조 증가 시퀀스 */
  readonly seq: bigint
  /** epoch milliseconds. 신선도 윈도우 판정용 */
  readonly timestamp: bigint
  /** XChaCha20 nonce 24B — 메시지마다 랜덤 */
  readonly nonce: Uint8Array
}

export interface Envelope {
  readonly header: Header
  readonly keys: readonly WrappedKey[]
  /** XChaCha20-Poly1305 암호문 + 16B 태그 */
  readonly body: Uint8Array
  /** 헤더+키+본문에 대한 Ed25519 분리 서명 */
  readonly signature: Uint8Array
}

function checkLength(name: string, value: Uint8Array, want: number): void {
  if (value.length !== want) {
    throw new Error(`${name} 은 ${want}바이트여야 한다 (받은 값: ${value.length})`)
  }
}

/**
 * AEAD 의 AAD — 헤더 전체를 직렬화한 것.
 *
 * 이것이 재전송 방지의 핵심이다: seq·timestamp·채널 태그가 여기 들어가므로
 * 공격자가 그중 하나라도 고치면 본문 복호화가 실패한다 (§10.5).
 */
export function headerBytes(h: Header): Uint8Array {
  checkLength('채널 태그', h.channelTag, CHANNEL_TAG_BYTES)
  checkLength('메시지 id', h.messageId, MESSAGE_ID_BYTES)
  checkLength('발신자 key id', h.senderKeyId, KEY_ID_BYTES)
  checkLength('nonce', h.nonce, NONCE_BYTES)

  const out = new Uint8Array(HEADER_FIXED_BYTES)
  const view = new DataView(out.buffer)
  let off = 0
  view.setUint32(off, MAGIC, false)
  off += 4
  out.set(h.channelTag, off)
  off += CHANNEL_TAG_BYTES
  out.set(h.messageId, off)
  off += MESSAGE_ID_BYTES
  out.set(h.senderKeyId, off)
  off += KEY_ID_BYTES
  view.setBigUint64(off, h.seq, false)
  off += 8
  view.setBigUint64(off, h.timestamp, false)
  off += 8
  out.set(h.nonce, off)
  return out
}

/**
 * 서명 대상 바이트 — 헤더 + 래핑 키 전부 + 본문.
 *
 * 래핑 키까지 포함하는 이유: 악의적 릴레이가 수신자를 빼거나 더한 것을
 * 검출한다. 헤더만 서명하면 그룹 구성 조작이 통과한다.
 */
export function signingBytes(
  h: Header,
  keys: readonly WrappedKey[],
  body: Uint8Array,
): Uint8Array {
  const head = headerBytes(h)
  const size = head.length + 4 + keys.length * (KEY_ID_BYTES + WRAPPED_KEY_BYTES) + body.length
  const out = new Uint8Array(size)
  let off = 0
  out.set(head, off)
  off += head.length
  new DataView(out.buffer).setUint32(off, keys.length, false)
  off += 4
  for (const k of keys) {
    checkLength('key id', k.keyId, KEY_ID_BYTES)
    checkLength('래핑 키', k.wrapped, WRAPPED_KEY_BYTES)
    out.set(k.keyId, off)
    off += KEY_ID_BYTES
    out.set(k.wrapped, off)
    off += WRAPPED_KEY_BYTES
  }
  out.set(body, off)
  return out
}

/**
 * 전체 파싱 없이 채널 태그만 꺼낸다.
 *
 * 라우팅 앞단이 "내 채널인가"만 묻는 자리가 있다 — 모르는 채널이면
 * 파싱도 복호화도 할 이유가 없고, 그 판정이 가장 싸야 한다 (§10.5).
 *
 * 오프셋을 호출자가 직접 계산하지 않게 여기에 둔다. 형식이 바뀌면 레이아웃을
 * 정의한 이 파일 하나만 고치면 된다.
 */
export function peekChannelTag(buf: Uint8Array): Uint8Array | undefined {
  if (buf.length < 4 + CHANNEL_TAG_BYTES) return undefined
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, false) !== MAGIC) return undefined
  return buf.subarray(4, 4 + CHANNEL_TAG_BYTES)
}

/** 봉투를 전송 바이트로 직렬화한다. */
export function encode(env: Envelope): Uint8Array {
  const signed = signingBytes(env.header, env.keys, env.body)
  checkLength('서명', env.signature, SIGNATURE_BYTES)
  const out = new Uint8Array(signed.length + SIGNATURE_BYTES)
  out.set(signed, 0)
  out.set(env.signature, signed.length)
  return out
}

/**
 * 전송 바이트를 봉투로 되돌린다.
 *
 * 구조 검사만 한다 — 서명 검증·복호화는 호출자가 한다. 검사 순서를
 * 싼 것부터 두기 위해서다 (§10.5: 구조 → seq → dedup → 비대칭 언랩).
 */
export function decode(buf: Uint8Array): Envelope {
  const need = (n: number, what: string) => {
    if (buf.length < n) throw new Error(`봉투가 잘렸다 — ${what} 을 읽을 수 없다`)
  }
  need(HEADER_FIXED_BYTES + 4 + SIGNATURE_BYTES, '헤더')

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, false) !== MAGIC) throw new Error('봉투 형식이 아니다')

  let off = 4
  const take = (n: number) => {
    const s = buf.subarray(off, off + n)
    off += n
    return s
  }
  const channelTag = take(CHANNEL_TAG_BYTES)
  const messageId = take(MESSAGE_ID_BYTES)
  const senderKeyId = take(KEY_ID_BYTES)
  const seq = view.getBigUint64(off, false)
  off += 8
  const timestamp = view.getBigUint64(off, false)
  off += 8
  const nonce = take(NONCE_BYTES)

  const count = view.getUint32(off, false)
  off += 4
  if (count > MAX_RECIPIENTS) throw new Error(`수신자가 너무 많다 (${count})`)
  need(off + count * (KEY_ID_BYTES + WRAPPED_KEY_BYTES) + SIGNATURE_BYTES, '래핑 키')

  const keys: WrappedKey[] = []
  for (let i = 0; i < count; i++) {
    keys.push({ keyId: take(KEY_ID_BYTES), wrapped: take(WRAPPED_KEY_BYTES) })
  }

  const bodyLen = buf.length - off - SIGNATURE_BYTES
  if (bodyLen < 0) throw new Error('봉투가 잘렸다 — 본문을 읽을 수 없다')
  if (bodyLen > MAX_BODY_BYTES) throw new Error(`본문이 너무 크다 (${bodyLen}B)`)
  const body = take(bodyLen)
  const signature = take(SIGNATURE_BYTES)

  return {
    header: { channelTag, messageId, senderKeyId, seq, timestamp, nonce },
    keys,
    body,
    signature,
  }
}
