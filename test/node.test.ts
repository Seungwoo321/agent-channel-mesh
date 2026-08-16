/**
 * 노드 테스트
 *
 * 노드가 존재하는 이유는 어댑터가 암호를 조립하지 않게 하는 것이다.
 * 그래서 여기서 확인하는 것은 "동작하는가"보다 **"어댑터가 빠뜨릴 수 있는
 * 것을 노드가 대신 지키는가"** 다 — 검사 순서, 발화 제어, 채널 격리.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { Channel } from '../src/channel/channel.js'
import { MeshNode, type Inbound } from '../src/node/node.js'

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

/** 같은 비밀을 아는 두 노드를 만든다 — 실제 배치와 같은 모양. */
function pair(options: { mentions?: string[]; budget?: number } = {}) {
  const secret = new Channel().secret
  const chA = new Channel({ secret, name: '테스트' })
  const chB = new Channel({ secret, name: '테스트' })
  for (const ch of [chA, chB]) {
    ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey, label: 'alice' })
    ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey, label: 'bob' })
  }
  const nodeA = new MeshNode({ identity: alice })
  const nodeB = new MeshNode({ identity: bob })
  const id = nodeA.join(chA)
  nodeB.join(chB, { mentions: options.mentions, messageBudget: options.budget })
  return { nodeA, nodeB, id, chA, chB }
}

const inbound = (r: Awaited<ReturnType<MeshNode['accept']>>): Inbound => {
  if ('reason' in r) throw new Error(`버려졌다: ${r.reason} — ${r.detail}`)
  return r
}

describe('채널 참여', () => {
  test('같은 비밀이면 같은 채널 id 다', () => {
    const { nodeA, nodeB, id } = pair()
    expect(nodeB.channelIds()).toEqual([id])
    expect(nodeA.channelIds()).toEqual([id])
  })

  test('두 번 붙어도 하나다', () => {
    const secret = new Channel().secret
    const node = new MeshNode({ identity: alice })
    node.join(new Channel({ secret }))
    node.join(new Channel({ secret }))
    expect(node.channelIds()).toHaveLength(1)
  })

  test('떠나면 목록에서 빠진다', () => {
    const { nodeA, id } = pair()
    expect(nodeA.leave(id)).toBe(true)
    expect(nodeA.channelIds()).toHaveLength(0)
  })

  test('붙지 않은 채널로는 보내지 못한다', async () => {
    const node = new MeshNode({ identity: alice })
    await expect(node.send('없는채널', '안녕')).rejects.toThrow(/붙어 있지 않은/)
  })

  test('나 혼자인 채널로는 보내지 못한다', async () => {
    const ch = new Channel()
    ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey })
    const node = new MeshNode({ identity: alice })
    const id = node.join(ch)
    await expect(node.send(id, '혼잣말')).rejects.toThrow(/수신자가 없다/)
  })
})

describe('주고받기', () => {
  test('평문이 왕복한다', async () => {
    const { nodeA, nodeB, id } = pair()
    const got = inbound(await nodeB.accept(await nodeA.send(id, '안녕하세요')))
    expect(got.text).toBe('안녕하세요')
    expect(got.channelId).toBe(id)
    expect(got.senderLabel).toBe('alice')
  })

  test('봉투 어디에도 평문이 없다', async () => {
    const { nodeA, id } = pair()
    const wire = await nodeA.send(id, '이건 비밀입니다')
    expect(Buffer.from(wire).includes(Buffer.from('이건 비밀입니다'))).toBe(false)
  })

  test('seq 가 메시지마다 올라간다 — 재전송이 걸린다', async () => {
    const { nodeA, nodeB, id } = pair()
    const first = await nodeA.send(id, '하나')
    inbound(await nodeB.accept(first))
    inbound(await nodeB.accept(await nodeA.send(id, '둘')))

    // 첫 번째를 다시 넣으면 재전송으로 걸린다 (§10.5).
    const again = await nodeB.accept(first)
    expect(again).toMatchObject({ reason: 'replayed' })
  })

  test('멤버가 아닌 발신자는 버려진다 — §8', async () => {
    const { nodeB, id } = pair()
    const outsider = new MeshNode({ identity: mallory })
    // mallory 는 채널 비밀을 알지만(태그가 맞다) 멤버 목록에 없다.
    const ch = new Channel({ secret: nodeB.channel(id)!.secret })
    ch.add({ signPublicKey: mallory.signPublicKey, kemPublicKey: mallory.kemPublicKey })
    ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey })
    const oid = outsider.join(ch)

    const dropped = await nodeB.accept(await outsider.send(oid, '끼어들기'))
    expect(dropped).toMatchObject({ reason: 'unknown-sender' })
  })

  test('모르는 채널의 봉투는 복호화 전에 버려진다', async () => {
    const { nodeA, id } = pair()
    const wire = await nodeA.send(id, 'x')
    const stranger = new MeshNode({ identity: bob })
    expect(await stranger.accept(wire)).toMatchObject({ reason: 'unknown-channel' })
  })

  test('망가진 바이트는 malformed 다', async () => {
    const { nodeB } = pair()
    expect(await nodeB.accept(new Uint8Array(10))).toMatchObject({ reason: 'malformed' })
  })
})

describe('발화 제어를 노드가 강제한다 — §7', () => {
  test('멘션이 없으면 speak=false 지만 메시지는 온다', async () => {
    const { nodeA, nodeB, id } = pair({ mentions: ['bob'] })
    const got = inbound(await nodeB.accept(await nodeA.send(id, '아무나 도와줘')))
    // 읽되 응답하지 않는다 — 필터링이 아니다.
    expect(got.text).toBe('아무나 도와줘')
    expect(got.decision.speak).toBe(false)
    if (!got.decision.speak) expect(got.decision.reason).toBe('not-mentioned')
  })

  test('멘션되면 speak=true 다', async () => {
    const { nodeA, nodeB, id } = pair({ mentions: ['bob'] })
    const got = inbound(await nodeB.accept(await nodeA.send(id, '@bob 이것 좀 봐줘')))
    expect(got.decision.speak).toBe(true)
  })

  test('홉이 왕복마다 이어진다', async () => {
    const { nodeA, nodeB, id } = pair()
    const first = inbound(await nodeB.accept(await nodeA.send(id, '시작')))
    expect(first.hops).toBe(0)

    // 응답할 때 받은 홉을 이어 보낸다.
    const reply = await nodeB.send(id, '답', first.decision.speak ? first.decision.hops : 0)
    const back = inbound(await nodeA.accept(reply))
    expect(back.hops).toBe(1)
    expect(back.text).toBe('답')
  })

  test('홉 상한을 넘으면 사람에게 넘긴다', async () => {
    const secret = new Channel().secret
    const ch = new Channel({ secret })
    ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey })
    ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey })
    const nodeA = new MeshNode({ identity: alice })
    const nodeB = new MeshNode({ identity: bob })
    const id = nodeA.join(ch)
    nodeB.join(new Channel({ secret: ch.secret }), { maxHops: 2 })
    // nodeB 의 채널에도 멤버가 있어야 발신자를 안다.
    const chB = nodeB.channel(id)!
    chB.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey })
    chB.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey })

    const got = inbound(await nodeB.accept(await nodeA.send(id, '길어진 사슬', 5)))
    expect(got.decision.speak).toBe(false)
    if (!got.decision.speak) expect(got.decision.reason).toBe('hop-limit')
  })

  test('예산은 실제로 보낸 것만 깎는다', async () => {
    const { nodeA, id } = pair()
    const speech = nodeA.speech(id)!
    const before = speech.remaining
    await nodeA.send(id, '하나')
    expect(speech.remaining).toBe(before - 1)
  })

  test('예산이 소진되면 speak=false 다', async () => {
    const { nodeA, nodeB, id } = pair({ budget: 1 })
    nodeB.speech(id)!.spend()
    const got = inbound(await nodeB.accept(await nodeA.send(id, '@bob')))
    expect(got.decision.speak).toBe(false)
    if (!got.decision.speak) expect(got.decision.reason).toBe('budget')
  })
})

describe('홉 표시가 본문에 새지 않는다', () => {
  test('사용자에게 보이는 본문에 홉 접두가 없다', async () => {
    const { nodeA, nodeB, id } = pair()
    const got = inbound(await nodeB.accept(await nodeA.send(id, '평범한 문장', 3)))
    expect(got.text).toBe('평범한 문장')
    expect(got.hops).toBe(3)
  })

  test('본문이 홉 접두처럼 생겨도 깨지지 않는다', async () => {
    const { nodeA, nodeB, id } = pair()
    const tricky = 'acm/h:99\n진짜 본문'
    const got = inbound(await nodeB.accept(await nodeA.send(id, tricky, 1)))
    // 우리가 붙인 접두만 벗겨지고, 본문에 있던 것은 남는다.
    expect(got.text).toBe(tricky)
    expect(got.hops).toBe(1)
  })
})

describe('N명 채널', () => {
  test('셋이 붙으면 둘에게 간다', async () => {
    const secret = new Channel().secret
    const nodes = [alice, bob, mallory].map(identity => new MeshNode({ identity }))
    const ids = nodes.map((n, i) => {
      const ch = new Channel({ secret })
      for (const who of [alice, bob, mallory]) {
        ch.add({ signPublicKey: who.signPublicKey, kemPublicKey: who.kemPublicKey })
      }
      return n.join(ch, { messageBudget: 10 + i })
    })
    expect(new Set(ids).size).toBe(1)

    const wire = await nodes[0]!.send(ids[0]!, '팀 공지')
    for (const n of [nodes[1]!, nodes[2]!]) {
      expect(inbound(await n.accept(wire)).text).toBe('팀 공지')
    }
    // 발신자 자신은 수신자 목록에 없다 — 에코 억제의 아래층.
    expect(await nodes[0]!.accept(wire)).toMatchObject({ reason: 'not-recipient' })
  })
})
