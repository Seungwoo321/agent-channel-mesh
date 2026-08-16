/**
 * 신원 테스트
 *
 * Bun 의 WebCrypto 로 X25519 가 안 된다는 사실을 테스트로 못박는다 —
 * 나중에 누군가 "subtle 로 하면 되지 않나" 하고 바꾸는 것을 막는다.
 */
import { test, expect, describe } from 'bun:test'
import {
  createIdentity,
  deriveIdentity,
  generateSeed,
  sign,
  verify,
  fingerprintWords,
  keyIdOf,
  SEED_BYTES,
  KEY_ID_BYTES,
} from '../src/identity/keys.js'

describe('신원 파생', () => {
  test('시드는 32바이트다', () => {
    expect(generateSeed()).toHaveLength(SEED_BYTES)
    expect(SEED_BYTES).toBe(32)
  })

  test('시드가 같으면 신원이 같다 — 시드만 저장하면 된다', async () => {
    const seed = generateSeed()
    const a = await deriveIdentity(seed)
    const b = await deriveIdentity(seed)
    expect(a.signPublicKey).toEqual(b.signPublicKey)
    expect(a.kemPublicKey).toEqual(b.kemPublicKey)
    expect(a.fingerprint).toEqual(b.fingerprint)
    expect(a.keyId).toEqual(b.keyId)
  })

  test('시드가 다르면 신원이 다르다', async () => {
    const a = await createIdentity()
    const b = await createIdentity()
    expect(a.fingerprint).not.toEqual(b.fingerprint)
  })

  test('서명 키와 KEM 키는 서로 다르다 — 도메인이 분리돼 있다', async () => {
    const id = await createIdentity()
    expect(id.signPublicKey).not.toEqual(id.kemPublicKey)
    expect(id.signPrivateKey).not.toEqual(id.seed)
  })

  test('키 길이가 규격대로다', async () => {
    const id = await createIdentity()
    expect(id.signPublicKey).toHaveLength(32)
    expect(id.kemPublicKey).toHaveLength(32)
    expect(id.fingerprint).toHaveLength(16)
    expect(id.keyId).toHaveLength(KEY_ID_BYTES)
  })

  test('시드 길이가 틀리면 거부한다', async () => {
    await expect(deriveIdentity(new Uint8Array(31))).rejects.toThrow(/32바이트/)
  })

  test('지문은 16단어로 표시된다', async () => {
    const id = await createIdentity()
    expect(fingerprintWords(id)).toHaveLength(16)
  })
})

describe('key id 파생 — §10.12', () => {
  // 서명된 수신함 폴링의 소유권 검사는 전적으로 이 성질에 기댄다.
  // 한쪽 키만 바꿔도 key id 가 달라져야, 피해자의 KEM 공개키에 공격자가
  // 자기 서명 키쌍을 붙여 제시하는 경로가 막힌다.
  test('KEM 키가 바뀌면 key id 가 바뀐다', async () => {
    const a = await createIdentity()
    const b = await createIdentity()
    expect(keyIdOf(a.kemPublicKey, a.signPublicKey)).not.toEqual(
      keyIdOf(b.kemPublicKey, a.signPublicKey),
    )
  })

  test('서명키가 바뀌면 key id 가 바뀐다 — 이 한 줄이 사칭을 막는다', async () => {
    const a = await createIdentity()
    const b = await createIdentity()
    expect(keyIdOf(a.kemPublicKey, a.signPublicKey)).not.toEqual(
      keyIdOf(a.kemPublicKey, b.signPublicKey),
    )
  })

  test('신원의 key id 와 같은 값을 준다', async () => {
    const id = await createIdentity()
    expect(keyIdOf(id.kemPublicKey, id.signPublicKey)).toEqual(id.keyId)
  })

  test('8바이트다', async () => {
    const a = await createIdentity()
    const b = await createIdentity()
    expect(keyIdOf(a.kemPublicKey, a.signPublicKey)).toHaveLength(KEY_ID_BYTES)
    expect(keyIdOf(a.kemPublicKey, b.signPublicKey)).toHaveLength(8)
  })
})

describe('서명', () => {
  test('자기 서명을 검증한다', async () => {
    const id = await createIdentity()
    const msg = new TextEncoder().encode('봉투 내용')
    expect(verify(id.signPublicKey, msg, sign(id, msg))).toBe(true)
  })

  test('변조된 메시지를 거부한다', async () => {
    const id = await createIdentity()
    const msg = new TextEncoder().encode('봉투 내용')
    const sig = sign(id, msg)
    expect(verify(id.signPublicKey, new TextEncoder().encode('봉투 내욕'), sig)).toBe(false)
  })

  test('다른 사람의 키로는 검증되지 않는다', async () => {
    const a = await createIdentity()
    const b = await createIdentity()
    const msg = new TextEncoder().encode('봉투 내용')
    expect(verify(b.signPublicKey, msg, sign(a, msg))).toBe(false)
  })

  test('망가진 서명에 예외를 던지지 않고 false 를 준다', async () => {
    const id = await createIdentity()
    const msg = new TextEncoder().encode('봉투 내용')
    expect(verify(id.signPublicKey, msg, new Uint8Array(64))).toBe(false)
    expect(verify(id.signPublicKey, msg, new Uint8Array(3))).toBe(false)
  })

  test('서명은 64바이트다', async () => {
    const id = await createIdentity()
    expect(sign(id, new TextEncoder().encode('x'))).toHaveLength(64)
  })
})

describe('Bun WebCrypto 제약 — 회귀 방지', () => {
  test('subtle 로 X25519 파생이 안 된다 (그래서 @hpke 를 쓴다)', async () => {
    let derived = false
    try {
      const kp = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
        'deriveBits',
      ])) as unknown as CryptoKeyPair
      await crypto.subtle.deriveBits({ name: 'X25519', public: kp.publicKey }, kp.privateKey, 256)
      derived = true
    } catch {
      // 예상된 경로 — NotSupportedError
    }
    // 이 테스트가 실패하면 Bun 이 X25519 를 지원하기 시작한 것이다.
    // 그래도 @hpke 경로를 유지한다 — 결정 근거는 docs/architecture.md §10.1.
    expect(derived).toBe(false)
  })
})
