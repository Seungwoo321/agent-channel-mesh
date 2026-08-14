/**
 * 수신 경로 테스트
 *
 * 이 파일이 지키는 것은 두 가지다. 검사 순서가 §10.5 4항대로인가,
 * 그리고 실패한 봉투가 재전송 상태를 오염시키지 않는가.
 * 두 번째가 특히 중요하다 — 공격자가 위조 봉투로 seq 를 선점해
 * 정상 메시지를 막을 수 있으면 재전송 방지가 오히려 DoS 수단이 된다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.ts'
import { seal } from '../src/crypto/seal.ts'
import { encode } from '../src/crypto/envelope.ts'
import { ReplayGuard } from '../src/crypto/replay.ts'
import { receive } from '../src/crypto/receive.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const TAG = new Uint8Array(16).fill(0xab)

let alice: Identity
let bob: Identity
let mallory: Identity

beforeAll(async () => {
  ;[alice, bob, mallory] = await Promise.all([
    createIdentity(),
    createIdentity(),
    createIdentity(),
  ])
})

/** 신뢰 목록 — alice 만 안다. */
const lookupSender = (keyId: Uint8Array) =>
  equal(keyId, alice.keyId) ? alice.signPublicKey : undefined

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

async function fromAlice(text: string, seq: bigint, sender: Identity = alice) {
  return seal({
    sender,
    recipients: [{ kemPublicKey: bob.kemPublicKey }],
    channelTag: TAG,
    seq,
    plaintext: enc.encode(text),
  })
}

const take = (wire: Uint8Array | Awaited<ReturnType<typeof seal>>, guard: ReplayGuard) =>
  receive({ wire, recipient: bob, guard, lookupSender })

describe('정상 수신', () => {
  test('전송 바이트에서 평문까지 간다', async () => {
    const g = new ReplayGuard()
    const r = await take(encode(await fromAlice('안녕하세요', 1n)), g)
    expect(r.ok).toBe(true)
    if (r.ok) expect(dec.decode(r.plaintext)).toBe('안녕하세요')
  })

  test('디코딩된 봉투도 받는다', async () => {
    const g = new ReplayGuard()
    const r = await take(await fromAlice('봉투 직접', 1n), g)
    expect(r.ok).toBe(true)
  })

  test('연속 메시지를 순서대로 받는다', async () => {
    const g = new ReplayGuard()
    for (let i = 1n; i <= 5n; i++) {
      const r = await take(await fromAlice(`메시지 ${i}`, i), g)
      expect(r.ok).toBe(true)
    }
  })
})

describe('거부', () => {
  test('재전송을 거부한다', async () => {
    const g = new ReplayGuard()
    const wire = encode(await fromAlice('한 번만', 1n))
    expect((await take(wire, g)).ok).toBe(true)
    // 같은 봉투를 그대로 다시 던지면 seq 윈도우가 먼저 잡는다 —
    // dedup 은 그보다 비싼 검사라 거기까지 가지 않는다 (§10.5 4항).
    const again = await take(wire, g)
    expect(again).toMatchObject({ ok: false, reason: 'replayed' })
  })

  test('seq 를 바꾼 재전송은 message id 로 잡는다', async () => {
    // 악의적 릴레이가 seq 만 올려 같은 메시지를 다시 보내는 경우.
    // 이때는 seq 윈도우를 통과하므로 dedup 이 마지막 방어선이다.
    const g = new ReplayGuard()
    const env = await fromAlice('한 번만', 1n)
    expect((await take(env, g)).ok).toBe(true)
    // seq 를 바꾸면 서명이 깨지므로, 같은 message id 로 새로 봉인한다.
    const resent = await seal({
      sender: alice,
      recipients: [{ kemPublicKey: bob.kemPublicKey }],
      channelTag: TAG,
      seq: 2n,
      plaintext: enc.encode('한 번만'),
      messageId: env.header.messageId,
    })
    expect(await take(resent, g)).toMatchObject({ ok: false, reason: 'duplicate' })
  })

  test('모르는 발신자를 거부한다', async () => {
    const g = new ReplayGuard()
    const r = await take(encode(await fromAlice('누구세요', 1n, mallory)), g)
    expect(r).toMatchObject({ ok: false, reason: 'unknown-sender' })
  })

  test('서명이 깨진 봉투를 거부한다', async () => {
    const g = new ReplayGuard()
    const env = await fromAlice('위조', 1n)
    const forged = { ...env, signature: new Uint8Array(64) }
    expect(await take(forged, g)).toMatchObject({ ok: false, reason: 'signature' })
  })

  test('형식이 아닌 바이트를 거부한다', async () => {
    const g = new ReplayGuard()
    expect(await take(new Uint8Array(300), g)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  test('수신자가 아니면 그렇게 밝힌다', async () => {
    const g = new ReplayGuard()
    const env = await seal({
      sender: alice,
      recipients: [{ kemPublicKey: mallory.kemPublicKey }],
      channelTag: TAG,
      seq: 1n,
      plaintext: enc.encode('남의 대화'),
    })
    expect(await take(env, g)).toMatchObject({ ok: false, reason: 'not-recipient' })
  })

  test('오래된 메시지를 거부한다', async () => {
    const g = new ReplayGuard()
    const env = await seal({
      sender: alice,
      recipients: [{ kemPublicKey: bob.kemPublicKey }],
      channelTag: TAG,
      seq: 1n,
      plaintext: enc.encode('옛날 메시지'),
      timestamp: BigInt(Date.now() - 60 * 60 * 1000),
    })
    expect(await take(env, g)).toMatchObject({ ok: false, reason: 'stale' })
  })
})

describe('상태 오염 방지 — 위조가 정상을 막지 못한다', () => {
  test('서명이 깨진 봉투는 seq 를 선점하지 못한다', async () => {
    const g = new ReplayGuard()
    const real = await fromAlice('진짜', 7n)
    // 같은 seq 로 서명만 깨진 봉투를 먼저 던진다.
    expect(await take({ ...real, signature: new Uint8Array(64) }, g)).toMatchObject({
      ok: false,
      reason: 'signature',
    })
    // 진짜가 여전히 통과해야 한다.
    expect((await take(real, g)).ok).toBe(true)
  })

  test('모르는 발신자는 상태를 남기지 않는다', async () => {
    const g = new ReplayGuard()
    await take(encode(await fromAlice('x', 1n, mallory)), g)
    expect(g.senderCount).toBe(0)
    expect(g.cacheSize).toBe(0)
  })

  test('형식 오류는 상태를 남기지 않는다', async () => {
    const g = new ReplayGuard()
    await take(new Uint8Array(300), g)
    expect(g.senderCount).toBe(0)
  })

  test('수신자가 아닌 봉투도 재전송은 막는다', async () => {
    // 내 몫이 아니어도 서명은 유효하므로 guard 는 이미 갱신됐다.
    // 이건 의도된 동작이다 — 같은 봉투를 다시 던지는 것은 재전송이 맞다.
    const g = new ReplayGuard()
    const env = await seal({
      sender: alice,
      recipients: [{ kemPublicKey: mallory.kemPublicKey }],
      channelTag: TAG,
      seq: 1n,
      plaintext: enc.encode('남의 대화'),
    })
    expect(await take(env, g)).toMatchObject({ ok: false, reason: 'not-recipient' })
    expect(await take(env, g)).toMatchObject({ ok: false, reason: 'replayed' })
  })
})

describe('검사 순서 — 비싼 연산 보호', () => {
  test('서명이 재전송 검사보다 먼저다', async () => {
    const g = new ReplayGuard()
    const real = await fromAlice('x', 1n)
    await take(real, g)
    // 재전송이면서 서명도 깨진 봉투. 서명이 먼저 걸려야 한다.
    const both = { ...real, signature: new Uint8Array(64) }
    expect(await take(both, g)).toMatchObject({ ok: false, reason: 'signature' })
  })

  test('재전송 검사가 언랩보다 먼저다', async () => {
    // 재전송이면서 내 몫이 아닌 봉투. 재전송(대칭)이 먼저 걸려야
    // 언랩(비대칭)에 닿지 않는다.
    const g = new ReplayGuard()
    const env = await seal({
      sender: alice,
      recipients: [{ kemPublicKey: mallory.kemPublicKey }],
      channelTag: TAG,
      seq: 1n,
      plaintext: enc.encode('x'),
    })
    await take(env, g)
    expect(await take(env, g)).toMatchObject({ ok: false, reason: 'replayed' })
  })
})
