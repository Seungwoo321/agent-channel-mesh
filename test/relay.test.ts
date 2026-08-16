/**
 * 릴레이 테스트
 *
 * 릴레이는 신뢰 대상이 아니다. 그래서 이 파일이 지키는 것은 기능보다
 * **경계**다 — 릴레이가 내용을 못 읽는가, 못 읽는 채로 라우팅이 되는가.
 * 마지막 describe 는 §10.12 가 주장하는 성질(훔쳐 가도 못 읽는다)을
 * 서술로 남기지 않고 실제로 확인한다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { seal } from '../src/crypto/seal.js'
import { encode, decode } from '../src/crypto/envelope.js'
import { Channel } from '../src/channel/channel.js'
import { ReplayGuard } from '../src/crypto/replay.js'
import { receive } from '../src/crypto/receive.js'
import { open } from '../src/crypto/seal.js'
import { Relay, MAX_ENVELOPE_BYTES } from '../src/relay/relay.js'
import { MemoryStore, DEFAULT_TTL_MS } from '../src/relay/store.js'

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

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

async function envelopeFor(recipients: Identity[], text: string, seq = 1n) {
  return encode(
    await seal({
      sender: alice,
      recipients: recipients.map(r => ({
        kemPublicKey: r.kemPublicKey,
        signPublicKey: r.signPublicKey,
      })),
      channelTag: TAG,
      seq,
      plaintext: enc.encode(text),
    }),
  )
}

const relay = () => new Relay({ store: new MemoryStore() })

describe('라우팅', () => {
  test('수신자 큐에 넣는다', async () => {
    const r = relay()
    const res = await r.post(await envelopeFor([bob], '안녕'))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.recipients).toBe(1)
    expect(await r.depth(hex(bob.keyId))).toBe(1)
  })

  test('수신자 수만큼 큐에 넣는다', async () => {
    const r = relay()
    await r.post(await envelopeFor([bob, carol], '공지'))
    expect(await r.depth(hex(bob.keyId))).toBe(1)
    expect(await r.depth(hex(carol.keyId))).toBe(1)
  })

  test('수신자가 아니면 큐가 비어 있다', async () => {
    const r = relay()
    await r.post(await envelopeFor([bob], '둘만'))
    expect(await r.depth(hex(carol.keyId))).toBe(0)
  })

  test('꺼내면 큐가 빈다 — 배달을 추적하지 않는다', async () => {
    const r = relay()
    await r.post(await envelopeFor([bob], 'x'))
    expect(await r.fetch(hex(bob.keyId))).toHaveLength(1)
    expect(await r.fetch(hex(bob.keyId))).toHaveLength(0)
  })

  test('여러 메시지가 순서대로 쌓인다', async () => {
    const r = relay()
    for (let i = 1n; i <= 3n; i++) await r.post(await envelopeFor([bob], `${i}번`, i))
    const items = await r.fetch(hex(bob.keyId))
    expect(items).toHaveLength(3)
    // 도착 순서가 유지돼야 브릿지가 seq 로 정렬하기 전에도 자연스럽다.
    expect(items[0]!.receivedAt).toBeLessThanOrEqual(items[1]!.receivedAt)
  })

  test('limit 으로 나눠 가져간다', async () => {
    const r = relay()
    for (let i = 1n; i <= 5n; i++) await r.post(await envelopeFor([bob], 'x', i))
    expect(await r.fetch(hex(bob.keyId), 2)).toHaveLength(2)
    expect(await r.fetch(hex(bob.keyId), 2)).toHaveLength(2)
    expect(await r.fetch(hex(bob.keyId), 2)).toHaveLength(1)
  })

  test('key id 대소문자를 가리지 않는다', async () => {
    const r = relay()
    await r.post(await envelopeFor([bob], 'x'))
    expect(await r.fetch(hex(bob.keyId).toUpperCase())).toHaveLength(1)
  })
})

describe('거부', () => {
  test('형식이 아니면 거부한다', async () => {
    expect(await relay().post(new Uint8Array(300))).toMatchObject({
      ok: false,
      reason: 'malformed',
    })
  })

  test('잘린 봉투를 거부한다', async () => {
    const wire = await envelopeFor([bob], 'x')
    expect(await relay().post(wire.subarray(0, 50))).toMatchObject({
      ok: false,
      reason: 'malformed',
    })
  })

  test('너무 큰 입력을 파싱 전에 거부한다', async () => {
    // 크기 검사가 파싱보다 먼저여야 한다 — 거대한 입력을 파싱하는 것
    // 자체가 릴레이에 대한 가장 싼 공격이다.
    const huge = new Uint8Array(MAX_ENVELOPE_BYTES + 1)
    expect(await relay().post(huge)).toMatchObject({ ok: false, reason: 'too-large' })
  })

  test('거부된 봉투는 큐에 남지 않는다', async () => {
    const r = relay()
    await r.post(new Uint8Array(300))
    expect(await r.depth(hex(bob.keyId))).toBe(0)
  })
})

describe('릴레이는 내용을 모른다 — §릴레이 경계', () => {
  test('평문이 저장된 blob 어디에도 없다', async () => {
    const r = relay()
    await r.post(await envelopeFor([bob], '이건 비밀입니다'))
    const [item] = await r.fetch(hex(bob.keyId))
    expect(Buffer.from(item!.envelope).includes(Buffer.from('이건 비밀입니다'))).toBe(false)
  })

  test('릴레이를 지나도 수신자는 그대로 읽는다', async () => {
    const r = relay()
    await r.post(await envelopeFor([bob], '릴레이 왕복'))
    const [item] = await r.fetch(hex(bob.keyId))

    const out = await receive({
      wire: item!.envelope,
      recipient: bob,
      guard: new ReplayGuard(),
      lookupSender: () => alice.signPublicKey,
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(dec.decode(out.plaintext)).toBe('릴레이 왕복')
  })

  test('큐를 훔쳐 가도 읽지 못한다 — §10.12', async () => {
    // 인증이 없으므로 key id 만 알면 남의 큐를 비울 수 있다.
    // 그것으로 읽지는 못한다는 것이 §10.12 의 주장이고, 여기서 확인한다.
    const r = relay()
    await r.post(await envelopeFor([bob], '가로채기 대상'))
    const [stolen] = await r.fetch(hex(bob.keyId))
    expect(stolen).toBeDefined()

    // carol 이 봉투를 통째로 손에 넣었다. 자기 키로는 열리지 않는다.
    await expect(
      open({
        envelope: decode(stolen!.envelope),
        recipient: carol,
        senderSignPublicKey: alice.signPublicKey,
      }),
    ).rejects.toThrow(/수신자가 아니다/)
  })
})

describe('저장소', () => {
  test('TTL 이 지나면 사라진다', async () => {
    let clock = 1_000_000
    const store = new MemoryStore({ now: () => clock })
    const r = new Relay({ store, now: () => clock })
    await r.post(await envelopeFor([bob], 'x'))
    expect(await r.depth(hex(bob.keyId))).toBe(1)

    clock += DEFAULT_TTL_MS + 1
    expect(await r.depth(hex(bob.keyId))).toBe(0)
    expect(await r.fetch(hex(bob.keyId))).toHaveLength(0)
  })

  test('TTL 안이면 남아 있다 — 오프라인 전달', async () => {
    let clock = 1_000_000
    const store = new MemoryStore({ now: () => clock })
    const r = new Relay({ store, now: () => clock })
    await r.post(await envelopeFor([bob], '자리 비운 사이'))
    clock += DEFAULT_TTL_MS - 1000
    expect(await r.fetch(hex(bob.keyId))).toHaveLength(1)
  })

  test('큐 상한을 넘으면 오래된 것을 버린다', async () => {
    // 새 메시지를 거부하면 활발한 채널이 죽은 큐 하나 때문에 막힌다.
    const store = new MemoryStore({ maxQueue: 3 })
    const r = new Relay({ store })
    for (let i = 1n; i <= 5n; i++) await r.post(await envelopeFor([bob], `${i}`, i))
    expect(await r.depth(hex(bob.keyId))).toBe(3)
  })

  test('빈 큐 조회가 안전하다', async () => {
    const r = relay()
    expect(await r.fetch(hex(carol.keyId))).toHaveLength(0)
    expect(await r.depth(hex(carol.keyId))).toBe(0)
  })
})

describe('채널 위 실제 전달', () => {
  test('두 노드가 릴레이를 통해 대화한다', async () => {
    const secret = new Channel().secret
    const chA = new Channel({ secret })
    const chB = new Channel({ secret })
    for (const ch of [chA, chB]) {
      ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey })
      ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey })
    }
    const r = relay()
    const guardB = new ReplayGuard()

    // alice 가 보낸다.
    const wire = encode(
      await seal({
        sender: alice,
        recipients: chA.recipients(alice.keyId),
        channelTag: chA.tag,
        seq: 1n,
        plaintext: enc.encode('릴레이 경유 인사'),
      }),
    )
    expect((await r.post(wire)).ok).toBe(true)

    // bob 이 폴링해 받는다.
    const items = await r.fetch(hex(bob.keyId))
    expect(items).toHaveLength(1)
    const got = await receive({
      wire: items[0]!.envelope,
      recipient: bob,
      guard: guardB,
      lookupSender: chB.lookupSender,
    })
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(dec.decode(got.plaintext)).toBe('릴레이 경유 인사')
      expect(got.envelope.header.channelTag).toEqual(chB.tag)
    }
  })

  test('N명 채널이 릴레이를 통해 전달된다', async () => {
    const secret = new Channel().secret
    const ch = new Channel({ secret })
    for (const id of [alice, bob, carol]) {
      ch.add({ signPublicKey: id.signPublicKey, kemPublicKey: id.kemPublicKey })
    }
    const r = relay()

    const wire = encode(
      await seal({
        sender: alice,
        recipients: ch.recipients(alice.keyId),
        channelTag: ch.tag,
        seq: 1n,
        plaintext: enc.encode('팀 공지'),
      }),
    )
    await r.post(wire)

    for (const who of [bob, carol]) {
      const items = await r.fetch(hex(who.keyId))
      expect(items).toHaveLength(1)
      const got = await receive({
        wire: items[0]!.envelope,
        recipient: who,
        guard: new ReplayGuard(),
        lookupSender: ch.lookupSender,
      })
      expect(got.ok).toBe(true)
      if (got.ok) expect(dec.decode(got.plaintext)).toBe('팀 공지')
    }
    // 발신자 자신의 큐에는 들어가지 않는다 — 에코 억제의 아래층.
    expect(await r.depth(hex(alice.keyId))).toBe(0)
  })
})
