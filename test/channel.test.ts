/**
 * 채널 상태 테스트
 *
 * 마지막 describe 가 본론이다 — 채널·봉인·수신을 실제로 엮어서
 * "채널을 만들고 들어가 메시지를 주고받는다"가 성립하는지 본다.
 * 각 층이 따로 통과하는 것으로는 그게 증명되지 않는다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { Channel, deriveTag, CHANNEL_SECRET_BYTES } from '../src/channel/channel.js'
import { fingerprint } from '../src/identity/fingerprint.js'
import { seal } from '../src/crypto/seal.js'
import { encode, CHANNEL_TAG_BYTES } from '../src/crypto/envelope.js'
import { ReplayGuard } from '../src/crypto/replay.js'
import { receive } from '../src/crypto/receive.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

let alice: Identity
let bob: Identity
let carol: Identity
let mallory: Identity

beforeAll(async () => {
  ;[alice, bob, carol, mallory] = await Promise.all([
    createIdentity(),
    createIdentity(),
    createIdentity(),
    createIdentity(),
  ])
})

/** 신원을 멤버로 — 공개 부분만 넘긴다. */
const asMember = (id: Identity, label?: string) => ({
  signPublicKey: id.signPublicKey,
  kemPublicKey: id.kemPublicKey,
  ...(label ? { label } : {}),
})

describe('채널 태그 파생 — §10.11', () => {
  const secret = new Uint8Array(CHANNEL_SECRET_BYTES).fill(9)

  test('16바이트다', () => {
    expect(deriveTag(secret)).toHaveLength(CHANNEL_TAG_BYTES)
  })

  test('결정적이다 — 같은 비밀이면 같은 태그', () => {
    expect(deriveTag(secret)).toEqual(deriveTag(secret))
  })

  test('비밀이 다르면 태그가 다르다', () => {
    const other = new Uint8Array(CHANNEL_SECRET_BYTES).fill(10)
    expect(deriveTag(secret)).not.toEqual(deriveTag(other))
  })

  test('epoch 를 올리면 태그가 바뀐다 — 회전의 자리', () => {
    expect(deriveTag(secret, 0)).not.toEqual(deriveTag(secret, 1))
    expect(deriveTag(secret, 1)).not.toEqual(deriveTag(secret, 2))
  })

  test('태그에서 비밀을 되돌릴 수 없다 — HMAC 이다', () => {
    // 태그는 릴레이에 평문으로 보인다. 그것으로 비밀을 알 수 있으면
    // 릴레이가 채널에 들어올 수 있다.
    const tag = deriveTag(secret)
    expect(Buffer.from(secret).includes(Buffer.from(tag))).toBe(false)
  })

  test('비밀 길이가 틀리면 거부한다', () => {
    expect(() => deriveTag(new Uint8Array(16))).toThrow(/32바이트/)
  })

  test('음수 epoch 를 거부한다', () => {
    expect(() => deriveTag(secret, -1)).toThrow(/epoch/)
  })
})

describe('채널 생성', () => {
  test('비밀을 안 주면 새로 만든다', () => {
    const ch = new Channel()
    expect(ch.secret).toHaveLength(CHANNEL_SECRET_BYTES)
    expect(ch.tag).toHaveLength(CHANNEL_TAG_BYTES)
    expect(ch.size).toBe(0)
  })

  test('매번 다른 비밀이 나온다', () => {
    expect(new Channel().secret).not.toEqual(new Channel().secret)
  })

  test('같은 비밀로 만들면 같은 채널이다 — 초대가 성립하는 근거', () => {
    const ch = new Channel({ name: '팀 룸' })
    // 초대받은 쪽은 비밀만 받아서 같은 태그에 도달해야 한다.
    const joined = new Channel({ secret: ch.secret })
    expect(joined.tag).toEqual(ch.tag)
  })

  test('이름은 라우팅에 쓰이지 않는다', () => {
    const secret = new Uint8Array(CHANNEL_SECRET_BYTES).fill(3)
    const a = new Channel({ secret, name: '이름 A' })
    const b = new Channel({ secret, name: '완전히 다른 이름' })
    expect(a.tag).toEqual(b.tag)
  })
})

describe('멤버 관리', () => {
  test('추가하면 지문과 key id 가 계산된다', () => {
    const ch = new Channel()
    const m = ch.add(asMember(alice, '앨리스'))
    expect(m.fingerprint).toEqual(fingerprint(alice.signPublicKey))
    expect(m.keyId).toEqual(alice.keyId)
    expect(m.label).toBe('앨리스')
  })

  test('key id 로 조회한다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    expect(ch.has(alice.keyId)).toBe(true)
    expect(ch.get(alice.keyId)?.keyId).toEqual(alice.keyId)
    expect(ch.has(bob.keyId)).toBe(false)
  })

  test('같은 멤버를 두 번 넣어도 하나다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    ch.add(asMember(alice))
    expect(ch.size).toBe(1)
  })

  test('KEM 키는 같고 서명키가 다르면 거부한다 — 사칭 방지', () => {
    // key id 가 두 키에서 나오므로(§10.12) 이 쌍은 더 이상 충돌하지 않는다.
    // 그냥 두면 조용히 별도 멤버로 들어앉는다. 사람에게 넘겨야 한다.
    const ch = new Channel()
    ch.add(asMember(alice))
    expect(() =>
      ch.add({ signPublicKey: mallory.signPublicKey, kemPublicKey: alice.kemPublicKey }),
    ).toThrow(/지문을 다시 대조/)
    expect(ch.size).toBe(1)
  })

  test('서명키는 같고 KEM 키가 다르면 거부한다 — 지문이 맞아 보이는 쪽', () => {
    // 사람이 대조하는 지문은 서명키에서만 나온다. 이 항목을 허용하면
    // 신뢰된 지문을 띄우면서 본문은 공격자 KEM 키로 감싸게 된다.
    const ch = new Channel()
    ch.add(asMember(alice))
    expect(() =>
      ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: mallory.kemPublicKey }),
    ).toThrow(/지문을 다시 대조/)
    expect(ch.size).toBe(1)
  })

  test('제거하면 목록에서 빠진다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    ch.add(asMember(bob))
    expect(ch.remove(alice.keyId)).toBe(true)
    expect(ch.size).toBe(1)
    expect(ch.has(alice.keyId)).toBe(false)
  })

  test('없는 멤버 제거는 false 다', () => {
    expect(new Channel().remove(alice.keyId)).toBe(false)
  })

  test('공개키 길이가 틀리면 거부한다', () => {
    const ch = new Channel()
    expect(() =>
      ch.add({ signPublicKey: new Uint8Array(16), kemPublicKey: alice.kemPublicKey }),
    ).toThrow(/32바이트/)
    expect(() =>
      ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: new Uint8Array(16) }),
    ).toThrow(/32바이트/)
  })

  test('삽입 순서를 유지한다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    ch.add(asMember(bob))
    ch.add(asMember(carol))
    expect(ch.list().map(m => m.keyId)).toEqual([alice.keyId, bob.keyId, carol.keyId])
  })
})

describe('수신자 목록', () => {
  test('나를 뺀다 — 에코 억제의 아래층', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    ch.add(asMember(bob))
    ch.add(asMember(carol))
    const rs = ch.recipients(alice.keyId)
    expect(rs).toHaveLength(2)
    expect(rs.map(r => r.kemPublicKey)).not.toContainEqual(alice.kemPublicKey)
  })

  test('나 혼자면 비어 있다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    expect(ch.recipients(alice.keyId)).toHaveLength(0)
  })
})

describe('발신자 조회 — §8 허용목록', () => {
  test('멤버의 서명키를 준다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    expect(ch.lookupSender(alice.keyId)).toEqual(alice.signPublicKey)
  })

  test('멤버가 아니면 undefined 다', () => {
    expect(new Channel().lookupSender(mallory.keyId)).toBeUndefined()
  })

  test('제거된 멤버는 조회되지 않는다', () => {
    const ch = new Channel()
    ch.add(asMember(alice))
    ch.remove(alice.keyId)
    expect(ch.lookupSender(alice.keyId)).toBeUndefined()
  })
})

describe('실제 대화 — 채널 + 봉인 + 수신', () => {
  /** 한 노드의 로컬 상태. 각자 자기 채널 뷰와 재전송 상태를 가진다. */
  function node(self: Identity, secret: Uint8Array, members: Identity[]) {
    const channel = new Channel({ secret })
    for (const m of members) channel.add(asMember(m))
    return { self, channel, guard: new ReplayGuard() }
  }

  type Node = ReturnType<typeof node>

  async function send(from: Node, text: string, seq: bigint) {
    return encode(
      await seal({
        sender: from.self,
        recipients: from.channel.recipients(from.self.keyId),
        channelTag: from.channel.tag,
        seq,
        plaintext: enc.encode(text),
      }),
    )
  }

  const deliver = (to: Node, wire: Uint8Array) =>
    receive({
      wire,
      recipient: to.self,
      guard: to.guard,
      lookupSender: to.channel.lookupSender,
    })

  test('1:1 — 채널을 만들고 초대해 주고받는다', async () => {
    const secret = new Channel().secret
    const a = node(alice, secret, [alice, bob])
    const b = node(bob, secret, [alice, bob])

    // 같은 비밀 → 같은 태그. 릴레이는 이 태그로만 라우팅한다.
    expect(a.channel.tag).toEqual(b.channel.tag)

    const r = await deliver(b, await send(a, '안녕하세요', 1n))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(dec.decode(r.plaintext)).toBe('안녕하세요')
      expect(r.envelope.header.channelTag).toEqual(b.channel.tag)
    }
  })

  test('N명 — 한 번 보내면 모두가 읽는다', async () => {
    const secret = new Channel().secret
    const members = [alice, bob, carol]
    const a = node(alice, secret, members)
    const b = node(bob, secret, members)
    const c = node(carol, secret, members)

    const wire = await send(a, '팀 공지', 1n)
    for (const who of [b, c]) {
      const r = await deliver(who, wire)
      expect(r.ok).toBe(true)
      if (r.ok) expect(dec.decode(r.plaintext)).toBe('팀 공지')
    }
  })

  test('양방향 대화가 이어진다', async () => {
    const secret = new Channel().secret
    const a = node(alice, secret, [alice, bob])
    const b = node(bob, secret, [alice, bob])

    const first = await deliver(b, await send(a, '질문이 있어요', 1n))
    expect(first.ok).toBe(true)
    const reply = await deliver(a, await send(b, '말씀하세요', 1n))
    expect(reply.ok).toBe(true)
    if (reply.ok) expect(dec.decode(reply.plaintext)).toBe('말씀하세요')
  })

  test('멤버가 아닌 사람의 메시지는 버린다 — §8', async () => {
    const secret = new Channel().secret
    const b = node(bob, secret, [alice, bob])
    // mallory 가 채널 비밀을 알아내 태그를 맞춰도 멤버가 아니다.
    const outsider = node(mallory, secret, [mallory, bob])

    const r = await deliver(b, await send(outsider, '끼어들기', 1n))
    expect(r).toMatchObject({ ok: false, reason: 'unknown-sender' })
  })

  test('제거된 멤버는 이후 메시지를 읽지 못한다', async () => {
    const secret = new Channel().secret
    const a = node(alice, secret, [alice, bob, carol])
    const c = node(carol, secret, [alice, bob, carol])

    // 나가기 전 메시지는 읽힌다.
    expect((await deliver(c, await send(a, '나가기 전', 1n))).ok).toBe(true)

    // carol 을 뺀다. 회전할 그룹 키가 없다 — 수신자 목록에서 빠질 뿐이다.
    a.channel.remove(carol.keyId)
    const after = await deliver(c, await send(a, '나간 뒤', 2n))
    expect(after).toMatchObject({ ok: false, reason: 'not-recipient' })
  })

  test('제거해도 이미 받은 메시지는 읽힌다 — §10.4 그대로', async () => {
    const secret = new Channel().secret
    const a = node(alice, secret, [alice, bob, carol])
    const c = node(carol, secret, [alice, bob, carol])

    const wire = await send(a, '보관된 메시지', 1n)
    a.channel.remove(carol.keyId)
    // 순방향 비밀성이 없다는 것이 바로 이 뜻이다. 숨기지 않는다.
    expect((await deliver(c, wire)).ok).toBe(true)
  })

  test('다른 채널의 메시지는 태그가 다르다', async () => {
    const a = node(alice, new Channel().secret, [alice, bob])
    const other = node(alice, new Channel().secret, [alice, bob])
    const one = await send(a, 'x', 1n)
    const two = await send(other, 'x', 1n)
    expect(one).not.toEqual(two)
  })

  test('재전송은 채널 위에서도 막힌다', async () => {
    const secret = new Channel().secret
    const a = node(alice, secret, [alice, bob])
    const b = node(bob, secret, [alice, bob])

    const wire = await send(a, '한 번만', 1n)
    expect((await deliver(b, wire)).ok).toBe(true)
    expect(await deliver(b, wire)).toMatchObject({ ok: false, reason: 'replayed' })
  })
})
