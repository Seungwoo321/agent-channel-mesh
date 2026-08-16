/**
 * 봉인·개봉 테스트
 *
 * 왕복이 되는 것은 최소 조건일 뿐이다. 이 파일의 본론은 변조 거부다 —
 * AAD 결속이 실제로 동작하는지, 즉 헤더를 고치면 정말 복호화가 깨지는지
 * 확인한다. 그게 재전송 방지의 근거이기 때문이다 (§10.5).
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { seal, open, keyIdOf } from '../src/crypto/seal.js'
import { encode, decode, MAGIC, WRAPPED_KEY_BYTES } from '../src/crypto/envelope.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const TAG = new Uint8Array(16).fill(0xab)

let alice: Identity
let bob: Identity
let carol: Identity

beforeAll(async () => {
  ;[alice, bob, carol] = await Promise.all([
    createIdentity(),
    createIdentity(),
    createIdentity(),
  ])
})

const to = (...ids: Identity[]) =>
  ids.map(i => ({ kemPublicKey: i.kemPublicKey, signPublicKey: i.signPublicKey }))

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

async function sealTo(recipients: Identity[], text: string, seq = 1n) {
  return seal({
    sender: alice,
    recipients: to(...recipients),
    channelTag: TAG,
    seq,
    plaintext: enc.encode(text),
  })
}

describe('1:1 왕복', () => {
  test('보낸 것을 그대로 받는다', async () => {
    const env = await sealTo([bob], '안녕하세요')
    const out = await open({ envelope: env, recipient: bob, senderSignPublicKey: alice.signPublicKey })
    expect(dec.decode(out)).toBe('안녕하세요')
  })

  test('빈 본문도 처리한다', async () => {
    const env = await sealTo([bob], '')
    const out = await open({ envelope: env, recipient: bob, senderSignPublicKey: alice.signPublicKey })
    expect(out).toHaveLength(0)
  })

  test('큰 본문도 처리한다', async () => {
    const big = 'あ'.repeat(50_000)
    const env = await sealTo([bob], big)
    const out = await open({ envelope: env, recipient: bob, senderSignPublicKey: alice.signPublicKey })
    expect(dec.decode(out)).toBe(big)
  })

  test('릴레이는 본문을 읽을 수 없다', async () => {
    const env = await sealTo([bob], '비밀입니다')
    const wire = encode(env)
    // 평문이 전송 바이트 어디에도 나타나지 않는다.
    expect(Buffer.from(wire).includes(Buffer.from('비밀입니다'))).toBe(false)
  })
})

describe('N명 채널 — 팬아웃', () => {
  test('모든 수신자가 같은 평문을 얻는다', async () => {
    const env = await sealTo([bob, carol], '팀 공지')
    for (const who of [bob, carol]) {
      const out = await open({ envelope: env, recipient: who, senderSignPublicKey: alice.signPublicKey })
      expect(dec.decode(out)).toBe('팀 공지')
    }
  })

  test('수신자 수만큼 래핑 키가 붙는다', async () => {
    const env = await sealTo([bob, carol], 'x')
    expect(env.keys).toHaveLength(2)
    expect(env.keys[0]!.wrapped).toHaveLength(WRAPPED_KEY_BYTES)
  })

  test('본문은 한 번만 암호화된다 — 수신자가 늘어도 본문 크기가 같다', async () => {
    const one = await sealTo([bob], 'hello')
    const two = await sealTo([bob, carol], 'hello')
    expect(one.body.length).toBe(two.body.length)
  })

  test('멤버가 아니면 열 수 없다', async () => {
    const env = await sealTo([bob], '둘만의 대화')
    await expect(
      open({ envelope: env, recipient: carol, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow(/수신자가 아니다/)
  })

  test('수신자가 없으면 거부한다', async () => {
    await expect(sealTo([], 'x')).rejects.toThrow(/수신자가 없다/)
  })
})

describe('변조 거부 — AAD 결속', () => {
  test('seq 를 고치면 복호화가 깨진다', async () => {
    const env = await sealTo([bob], 'x')
    const tampered = { ...env, header: { ...env.header, seq: env.header.seq + 1n } }
    await expect(
      open({ envelope: tampered, recipient: bob, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow()
  })

  test('timestamp 를 고치면 복호화가 깨진다', async () => {
    const env = await sealTo([bob], 'x')
    const tampered = { ...env, header: { ...env.header, timestamp: 0n } }
    await expect(
      open({ envelope: tampered, recipient: bob, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow()
  })

  test('채널 태그를 고치면 복호화가 깨진다 — 채널 간 전용이 막힌다', async () => {
    const env = await sealTo([bob], 'x')
    const other = new Uint8Array(16).fill(0xcd)
    const tampered = { ...env, header: { ...env.header, channelTag: other } }
    await expect(
      open({ envelope: tampered, recipient: bob, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow()
  })

  test('본문을 한 비트 고치면 거부한다', async () => {
    const env = await sealTo([bob], 'x')
    const body = Uint8Array.from(env.body)
    body[0] = body[0]! ^ 0x01
    await expect(
      open({ envelope: { ...env, body }, recipient: bob, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow()
  })

  test('서명이 없으면 거부한다', async () => {
    const env = await sealTo([bob], 'x')
    await expect(
      open({
        envelope: { ...env, signature: new Uint8Array(64) },
        recipient: bob,
        senderSignPublicKey: alice.signPublicKey,
      }),
    ).rejects.toThrow(/서명/)
  })

  test('다른 사람이 보낸 척하면 거부한다', async () => {
    const env = await sealTo([bob], 'x')
    await expect(
      open({ envelope: env, recipient: bob, senderSignPublicKey: carol.signPublicKey }),
    ).rejects.toThrow(/서명/)
  })

  test('수신자를 빼면 거부한다 — 그룹 구성 조작 검출', async () => {
    const env = await sealTo([bob, carol], 'x')
    // bob 의 키만 남기고 carol 을 제거한다. bob 은 여전히 열 수 있어야
    // 정상이지만, 서명이 키 목록을 덮으므로 조작이 먼저 걸린다.
    const kept = env.keys.filter(k => !equalBytes(k.keyId, carol.keyId))
    expect(kept).toHaveLength(1)
    await expect(
      open({ envelope: { ...env, keys: kept }, recipient: bob, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow(/서명/)
  })

  test('수신자를 더해도 거부한다', async () => {
    const env = await sealTo([bob], 'x')
    const extra = { ...env, keys: [...env.keys, { keyId: carol.keyId, wrapped: new Uint8Array(WRAPPED_KEY_BYTES) }] }
    await expect(
      open({ envelope: extra, recipient: bob, senderSignPublicKey: alice.signPublicKey }),
    ).rejects.toThrow(/서명/)
  })
})

describe('직렬화', () => {
  test('인코딩·디코딩이 왕복한다', async () => {
    const env = await sealTo([bob, carol], '왕복 테스트')
    const back = decode(encode(env))
    expect(back.header.seq).toBe(env.header.seq)
    expect(back.header.channelTag).toEqual(env.header.channelTag)
    expect(back.header.nonce).toEqual(env.header.nonce)
    expect(back.keys).toHaveLength(2)
    expect(back.body).toEqual(env.body)
    expect(back.signature).toEqual(env.signature)
  })

  test('디코딩한 봉투를 열 수 있다', async () => {
    const env = await sealTo([bob], '전송 후 개봉')
    const out = await open({
      envelope: decode(encode(env)),
      recipient: bob,
      senderSignPublicKey: alice.signPublicKey,
    })
    expect(dec.decode(out)).toBe('전송 후 개봉')
  })

  test('형식이 아니면 거부한다', () => {
    expect(() => decode(new Uint8Array(200))).toThrow(/형식/)
  })

  test('잘린 봉투를 거부한다', async () => {
    const wire = encode(await sealTo([bob], 'x'))
    expect(() => decode(wire.subarray(0, 40))).toThrow(/잘렸다/)
  })

  test('magic 이 맞아도 내용이 잘렸으면 거부한다', () => {
    const buf = new Uint8Array(80)
    new DataView(buf.buffer).setUint32(0, MAGIC, false)
    expect(() => decode(buf)).toThrow(/잘렸다/)
  })
})

describe('신선도·유일성', () => {
  test('같은 평문도 매번 다른 암호문이 된다', async () => {
    const a = await sealTo([bob], '같은 말')
    const b = await sealTo([bob], '같은 말')
    expect(a.body).not.toEqual(b.body)
    expect(a.header.nonce).not.toEqual(b.header.nonce)
    expect(a.header.messageId).not.toEqual(b.header.messageId)
  })

  test('nonce 는 24바이트다 — XChaCha20', async () => {
    const env = await sealTo([bob], 'x')
    expect(env.header.nonce).toHaveLength(24)
  })

  test('key id 는 두 공개키에서 나온다 — §10.12', async () => {
    const env = await sealTo([bob], 'x')
    expect(env.keys[0]!.keyId).toEqual(keyIdOf(bob.kemPublicKey, bob.signPublicKey))
    expect(env.header.senderKeyId).toEqual(alice.keyId)
  })
})

describe('전송 크기 — 문서와 일치', () => {
  // docs/architecture.md §10.6 의 수치를 못박는다. 설계 문서가 한때
  // 래핑 키를 56B 로 적었으나 실제는 80B 였다(콘텐츠 키 32B 누락).
  // 이 테스트가 그 종류의 드리프트를 다시 조용히 지나가지 않게 한다.
  test('래핑 키는 80B 다 — enc 32 + 콘텐츠 키 32 + 태그 16', async () => {
    const env = await sealTo([bob], 'x')
    expect(env.keys[0]!.wrapped).toHaveLength(80)
    expect(WRAPPED_KEY_BYTES).toBe(80)
  })

  test('본문 500B 기준 오버헤드가 문서 수치와 같다', async () => {
    const body = new Uint8Array(500).fill(65)
    for (const [n, expected] of [
      [1, 256],
      [2, 344],
      [20, 1928],
    ] as const) {
      const rs = await Promise.all(Array.from({ length: n }, () => createIdentity()))
      const env = await seal({
        sender: alice,
        recipients: to(...rs),
        channelTag: TAG,
        seq: 1n,
        plaintext: body,
      })
      expect(encode(env).length - body.length).toBe(expected)
    }
  })
})
