import { test, expect } from 'bun:test'
import { createIdentity, sign, type Identity } from '../src/identity/keys.js'
import {
  FETCH_LABEL,
  FETCH_NONCE_BYTES,
  FETCH_WINDOW_MS,
  HEADER_KEM,
  HEADER_NONCE,
  HEADER_SIG,
  HEADER_SIGN,
  HEADER_TIME,
  fetchAuthHeaders,
  fetchSigningBytes,
  newFetchNonce,
  parseFetchAuth,
  verifyFetchAuth,
  type FetchAuth,
} from '../src/relay/fetch-auth.js'

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** 한 신원이 자기 큐를 폴링하는 정상 요청. */
function authFor(id: Identity, timeMs = Date.now()): FetchAuth {
  const nonce = newFetchNonce()
  return {
    kemPublicKey: id.kemPublicKey,
    signPublicKey: id.signPublicKey,
    signature: sign(id, fetchSigningBytes(id.keyId, timeMs, nonce)),
    timeMs,
    nonce,
  }
}

/** 실제 전송 경로를 그대로 통과시킨다 — 헤더로 폈다가 다시 파싱한다. */
function roundTrip(auth: FetchAuth, override: Record<string, string> = {}): FetchAuth | null {
  return parseFetchAuth(new Headers({ ...fetchAuthHeaders(auth), ...override }))
}

test('정상 요청은 헤더 왕복 후에도 검증을 통과한다', async () => {
  const id = await createIdentity()
  const now = Date.now()
  const parsed = roundTrip(authFor(id, now))

  expect(parsed).not.toBeNull()
  expect(verifyFetchAuth(hex(id.keyId), parsed!, now)).toEqual({ ok: true })
})

test('경로의 key id 대소문자는 무시한다', async () => {
  const id = await createIdentity()
  const now = Date.now()
  const parsed = roundTrip(authFor(id, now))!

  expect(verifyFetchAuth(hex(id.keyId).toUpperCase(), parsed, now).ok).toBe(true)
})

test('남의 KEM 공개키에 자기 서명키를 붙이면 key id 불일치로 거부된다', async () => {
  // §10.12 의 핵심 공격. 공격자는 피해자의 KEM 공개키(봉투 평문에 있다)를 알고,
  // 자기가 방금 만든 서명 키쌍으로 서명한다. key id 가 두 키를 함께 묶으므로 막힌다.
  const victim = await createIdentity()
  const attacker = await createIdentity()
  const now = Date.now()

  const nonce = newFetchNonce()
  const forged: FetchAuth = {
    kemPublicKey: victim.kemPublicKey,
    signPublicKey: attacker.signPublicKey,
    // 공격자는 자기 서명키로 정직하게 서명한다 — 서명 자체는 유효하다.
    signature: sign(attacker, fetchSigningBytes(victim.keyId, now, nonce)),
    timeMs: now,
    nonce,
  }

  const parsed = roundTrip(forged)!
  const result = verifyFetchAuth(hex(victim.keyId), parsed, now)
  expect(result.ok).toBe(false)
  expect(result).toMatchObject({ reason: 'key-id-mismatch' })
})

test('KEM 공개키만 다른 것으로 바꾸면 거부된다', async () => {
  const id = await createIdentity()
  const other = await createIdentity()
  const now = Date.now()

  const parsed = roundTrip(authFor(id, now), { [HEADER_KEM]: hex(other.kemPublicKey) })!
  expect(verifyFetchAuth(hex(id.keyId), parsed, now)).toMatchObject({
    ok: false,
    reason: 'key-id-mismatch',
  })
})

test('서명 공개키만 다른 것으로 바꾸면 거부된다', async () => {
  const id = await createIdentity()
  const other = await createIdentity()
  const now = Date.now()

  const parsed = roundTrip(authFor(id, now), { [HEADER_SIGN]: hex(other.signPublicKey) })!
  expect(verifyFetchAuth(hex(id.keyId), parsed, now)).toMatchObject({
    ok: false,
    reason: 'key-id-mismatch',
  })
})

test('서명 1바이트가 변조되면 거부된다', async () => {
  const id = await createIdentity()
  const now = Date.now()
  const auth = authFor(id, now)

  const tampered = Uint8Array.from(auth.signature)
  tampered[0] = tampered[0]! ^ 0x01
  const parsed = roundTrip(auth, { [HEADER_SIG]: hex(tampered) })!

  expect(verifyFetchAuth(hex(id.keyId), parsed, now)).toMatchObject({
    ok: false,
    reason: 'bad-signature',
  })
})

test('nonce 가 변조되면 서명 불일치로 거부된다', async () => {
  const id = await createIdentity()
  const now = Date.now()
  const auth = authFor(id, now)

  const tampered = Uint8Array.from(auth.nonce)
  tampered[FETCH_NONCE_BYTES - 1] = tampered[FETCH_NONCE_BYTES - 1]! ^ 0xff
  const parsed = roundTrip(auth, { [HEADER_NONCE]: hex(tampered) })!

  // key id 는 nonce 와 무관하므로 소유권 검사는 통과하고 서명에서 걸린다.
  expect(verifyFetchAuth(hex(id.keyId), parsed, now)).toMatchObject({
    ok: false,
    reason: 'bad-signature',
  })
})

test('시각이 창 밖 과거면 거부된다', async () => {
  const id = await createIdentity()
  const now = Date.now()
  const parsed = roundTrip(authFor(id, now - FETCH_WINDOW_MS - 1000))!

  expect(verifyFetchAuth(hex(id.keyId), parsed, now)).toMatchObject({
    ok: false,
    reason: 'stale-request',
  })
})

test('시각이 창 밖 미래여도 거부된다', async () => {
  const id = await createIdentity()
  const now = Date.now()
  const parsed = roundTrip(authFor(id, now + FETCH_WINDOW_MS + 1000))!

  expect(verifyFetchAuth(hex(id.keyId), parsed, now)).toMatchObject({
    ok: false,
    reason: 'stale-request',
  })
})

test('창 경계 안쪽은 양방향 모두 통과한다', async () => {
  const id = await createIdentity()
  const now = Date.now()

  const past = roundTrip(authFor(id, now - FETCH_WINDOW_MS))!
  const future = roundTrip(authFor(id, now + FETCH_WINDOW_MS))!

  expect(verifyFetchAuth(hex(id.keyId), past, now).ok).toBe(true)
  expect(verifyFetchAuth(hex(id.keyId), future, now).ok).toBe(true)
})

test('헤더가 하나라도 빠지면 parseFetchAuth 가 null 을 준다', async () => {
  const id = await createIdentity()
  const full = fetchAuthHeaders(authFor(id))

  for (const name of [HEADER_KEM, HEADER_SIGN, HEADER_SIG, HEADER_TIME, HEADER_NONCE]) {
    const headers = new Headers(full)
    headers.delete(name)
    expect(parseFetchAuth(headers)).toBeNull()
  }
})

test('길이나 형식이 틀린 헤더는 parseFetchAuth 가 null 을 준다', async () => {
  const id = await createIdentity()
  const auth = authFor(id)

  const bad: Record<string, string>[] = [
    { [HEADER_KEM]: hex(auth.kemPublicKey).slice(0, 62) }, // 31바이트
    { [HEADER_SIGN]: hex(auth.signPublicKey) + '00' }, // 33바이트
    { [HEADER_SIG]: hex(auth.signature).slice(0, 126) }, // 63바이트
    { [HEADER_NONCE]: hex(auth.nonce).slice(0, 30) }, // 15바이트
    { [HEADER_KEM]: 'z'.repeat(64) }, // hex 가 아님
    { [HEADER_TIME]: '-1' },
    { [HEADER_TIME]: '12.5' },
    { [HEADER_TIME]: '' },
    { [HEADER_TIME]: '9'.repeat(20) }, // 안전한 정수 밖
  ]

  for (const override of bad) {
    expect(roundTrip(auth, override)).toBeNull()
  }
})

test('fetchSigningBytes 는 44바이트이고 라벨로 시작한다', () => {
  const keyId = new Uint8Array(8).fill(1)
  const nonce = new Uint8Array(FETCH_NONCE_BYTES).fill(2)
  const bytes = fetchSigningBytes(keyId, 1, nonce)

  expect(FETCH_LABEL.length).toBe(12)
  expect(bytes.length).toBe(44)
  expect(bytes.slice(0, 12)).toEqual(FETCH_LABEL)
  expect(bytes.slice(12, 20)).toEqual(keyId)
  // timeMs 는 big-endian uint64 — 1 은 마지막 바이트에만 남는다.
  expect(Array.from(bytes.slice(20, 28))).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  expect(bytes.slice(28)).toEqual(nonce)
})

test('fetchSigningBytes 는 입력 하나만 달라도 결과가 달라진다', () => {
  const keyId = new Uint8Array(8).fill(1)
  const nonce = new Uint8Array(FETCH_NONCE_BYTES).fill(2)
  const base = hex(fetchSigningBytes(keyId, 1_700_000_000_000, nonce))

  const otherKeyId = Uint8Array.from(keyId)
  otherKeyId[7] = 9
  const otherNonce = Uint8Array.from(nonce)
  otherNonce[0] = 9

  expect(hex(fetchSigningBytes(otherKeyId, 1_700_000_000_000, nonce))).not.toBe(base)
  expect(hex(fetchSigningBytes(keyId, 1_700_000_000_001, nonce))).not.toBe(base)
  expect(hex(fetchSigningBytes(keyId, 1_700_000_000_000, otherNonce))).not.toBe(base)
})

test('fetchSigningBytes 는 길이가 틀린 입력을 던진다', () => {
  const keyId = new Uint8Array(8)
  const nonce = new Uint8Array(FETCH_NONCE_BYTES)

  expect(() => fetchSigningBytes(new Uint8Array(7), 1, nonce)).toThrow()
  expect(() => fetchSigningBytes(keyId, 1, new Uint8Array(15))).toThrow()
  expect(() => fetchSigningBytes(keyId, -1, nonce)).toThrow()
  expect(() => fetchSigningBytes(keyId, 1.5, nonce)).toThrow()
})

test('newFetchNonce 는 매번 다른 16바이트를 준다', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 64; i++) {
    const n = newFetchNonce()
    expect(n.length).toBe(FETCH_NONCE_BYTES)
    seen.add(hex(n))
  }
  expect(seen.size).toBe(64)
})
