/**
 * 어댑터 테스트
 *
 * 어댑터의 계약은 두 방향뿐이다(§4). 세션→메시는 두 어댑터가 공유하므로
 * 한 번만 확인하고, 메시→세션은 갈리는 지점이라 각각 확인한다.
 *
 * 가장 중요한 확인은 **경계**다 — 어댑터가 코어를 우회해 암호나 정책을
 * 스스로 조립하지 않는가. 그래서 발화 제어가 툴 경로에서도 살아 있는지를
 * 본다: 모델이 툴을 직접 부르는 길이 예산 우회로가 되면 §7 이 무너진다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.ts'
import { Channel } from '../src/channel/channel.ts'
import { MeshNode, type Inbound } from '../src/node/node.ts'
import { Inbox } from '../src/adapter/inbox.ts'
import { callTool } from '../src/adapter/tools.ts'
import { ClaudeAdapter, CAPABILITIES, INSTRUCTIONS } from '../src/adapter/claude.ts'

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

function pair(options: { budget?: number } = {}) {
  const secret = new Channel().secret
  const build = () => {
    const ch = new Channel({ secret, name: '팀룸' })
    ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey, label: 'alice' })
    ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey, label: 'bob' })
    return ch
  }
  const nodeA = new MeshNode({ identity: alice })
  const nodeB = new MeshNode({ identity: bob })
  const id = nodeA.join(build(), { messageBudget: options.budget })
  nodeB.join(build())
  return { nodeA, nodeB, id }
}

const inbound = (r: Awaited<ReturnType<MeshNode['accept']>>): Inbound => {
  if ('reason' in r) throw new Error(`버려졌다: ${r.reason}`)
  return r
}

describe('세션 → 메시 (두 어댑터 공통)', () => {
  test('send 가 채널로 나간다', async () => {
    const { nodeA, nodeB, id } = pair()
    // 툴 경로로 보낸 것이 상대에게 그대로 도착해야 한다.
    let sent: Uint8Array | undefined
    const spy = new Proxy(nodeA, {
      get: (t, p: keyof MeshNode) =>
        p === 'send'
          ? async (...args: Parameters<MeshNode['send']>) => (sent = await t.send(...args))
          : t[p],
    })
    const res = await callTool({ node: spy as MeshNode }, 'send', { channel_id: id, text: '툴로 보냄' })
    expect(res.isError).toBeUndefined()
    expect(inbound(await nodeB.accept(sent!)).text).toBe('툴로 보냄')
  })

  test('붙지 않은 채널은 오류를 돌려준다 — 던지지 않는다', async () => {
    const { nodeA } = pair()
    const res = await callTool({ node: nodeA }, 'send', { channel_id: '없음', text: 'x' })
    expect(res.isError).toBe(true)
  })

  test('인자가 없으면 오류다', async () => {
    const { nodeA, id } = pair()
    expect((await callTool({ node: nodeA }, 'send', { channel_id: id })).isError).toBe(true)
    expect((await callTool({ node: nodeA }, 'send', { text: 'x' })).isError).toBe(true)
  })

  test('모르는 툴은 오류다', async () => {
    const { nodeA } = pair()
    expect((await callTool({ node: nodeA }, '없는툴', {})).isError).toBe(true)
  })

  test('예산이 소진되면 툴이 거부한다 — 모델의 우회로를 막는다', async () => {
    const { nodeA, id } = pair({ budget: 1 })
    expect((await callTool({ node: nodeA }, 'send', { channel_id: id, text: '1' })).isError).toBeUndefined()
    const second = await callTool({ node: nodeA }, 'send', { channel_id: id, text: '2' })
    expect(second.isError).toBe(true)
    expect(second.text).toMatch(/예산/)
  })

  test('channels 가 멤버와 지문을 보여준다', async () => {
    const { nodeA, id } = pair()
    const res = await callTool({ node: nodeA }, 'channels', {})
    expect(res.text).toContain('팀룸')
    expect(res.text).toContain(id)
    expect(res.text).toContain('alice')
    // 지문은 128비트 전체다 — 잘라 보여주지 않는다 (§9).
    // `toHex` 가 읽기 쉽게 4자씩 끊으므로 그 형태로 확인한다.
    expect(res.text).toMatch(/fp (?:[0-9a-f]{4} ){7}[0-9a-f]{4}/)
  })

  test('붙은 채널이 없으면 그렇게 말한다', async () => {
    const empty = new MeshNode({ identity: alice })
    expect((await callTool({ node: empty }, 'channels', {})).text).toContain('없다')
  })
})

describe('수신함 어댑터 — 꺼내 가는 전달', () => {
  test('쌓았다가 꺼낸다', async () => {
    const { nodeA, nodeB, id } = pair()
    const inbox = new Inbox()
    inbox.push(inbound(await nodeB.accept(await nodeA.send(id, '첫 메시지'))))

    const res = await callTool({ node: nodeB, inbox }, 'inbox', {})
    expect(res.text).toContain('첫 메시지')
    expect(res.text).toContain('alice')
  })

  test('읽은 것은 다시 나오지 않는다 — 폴링이 왕복이 되지 않게', async () => {
    const { nodeA, nodeB, id } = pair()
    const inbox = new Inbox()
    inbox.push(inbound(await nodeB.accept(await nodeA.send(id, '한 번만'))))

    expect((await callTool({ node: nodeB, inbox }, 'inbox', {})).text).toContain('한 번만')
    expect((await callTool({ node: nodeB, inbox }, 'inbox', {})).text).toContain('새 메시지가 없다')
  })

  test('채널별로 격리해 읽는다 — §6', async () => {
    const inbox = new Inbox()
    inbox.push(fake('ch-a', '에이 내용'))
    inbox.push(fake('ch-b', '비 내용'))

    const onlyA = inbox.take('ch-a')
    expect(onlyA).toHaveLength(1)
    expect(onlyA[0]!.text).toBe('에이 내용')
    // 다른 채널 것은 여전히 안 읽음으로 남는다.
    expect(inbox.unread('ch-b')).toBe(1)
  })

  test('안 읽은 개수를 센다', () => {
    const inbox = new Inbox()
    inbox.push(fake('ch', '1'))
    inbox.push(fake('ch', '2'))
    expect(inbox.unread()).toBe(2)
    inbox.take()
    expect(inbox.unread()).toBe(0)
    // 읽어도 지우지 않는다 — 사람이 되돌아볼 수 있어야 한다.
    expect(inbox.size).toBe(2)
  })

  test('상한을 넘으면 오래된 것을 버린다', () => {
    const inbox = new Inbox({ capacity: 3 })
    for (let i = 0; i < 5; i++) inbox.push(fake('ch', `${i}`))
    expect(inbox.size).toBe(3)
    expect(inbox.peek()[0]!.message.text).toBe('2')
  })

  test('응답하지 않을 메시지도 읽히되 표시가 붙는다 — §7', async () => {
    const inbox = new Inbox()
    inbox.push(fake('ch', '남 얘기', { speak: false, reason: 'not-mentioned', detail: '' }))
    const res = await callTool({ node: new MeshNode({ identity: bob }), inbox }, 'inbox', {})
    expect(res.text).toContain('남 얘기')
    expect(res.text).toContain('응답 안 함')
  })

  test('수신함 없는 어댑터에서 inbox 는 오류다', async () => {
    const res = await callTool({ node: new MeshNode({ identity: bob }) }, 'inbox', {})
    expect(res.isError).toBe(true)
  })
})

describe('Claude 어댑터 — 능동 주입', () => {
  test('capability 를 선언한다', () => {
    expect(CAPABILITIES.experimental).toHaveProperty('claude/channel')
  })

  test('meta 키에 하이픈이 없다 — 조용히 삭제되는 값이다', async () => {
    const { nodeA, nodeB, id } = pair()
    const sent: { method: string; params: Record<string, unknown> }[] = []
    const adapter = new ClaudeAdapter({
      node: nodeB,
      notify: async n => void sent.push(n),
    })
    await adapter.inject(inbound(await nodeB.accept(await nodeA.send(id, '주입 확인'))))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
    const meta = sent[0]!.params.meta as Record<string, string>
    for (const key of Object.keys(meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/)
    expect(meta.chat_id).toBe(id)
    expect(meta.sender).toBe('alice')
  })

  test('본문과 발신자를 함께 넣는다', async () => {
    const { nodeA, nodeB, id } = pair()
    let content = ''
    const adapter = new ClaudeAdapter({
      node: nodeB,
      notify: async n => void (content = n.params.content as string),
    })
    await adapter.inject(inbound(await nodeB.accept(await nodeA.send(id, '내용입니다'))))
    expect(content).toContain('alice')
    expect(content).toContain('내용입니다')
  })

  test('응답하지 않을 메시지도 주입된다 — 필터링이 아니다', async () => {
    let content = ''
    const adapter = new ClaudeAdapter({
      node: new MeshNode({ identity: bob }),
      notify: async n => void (content = n.params.content as string),
    })
    await adapter.inject(fake('ch', '남 얘기', { speak: false, reason: 'not-mentioned', detail: '' }))
    expect(content).toContain('남 얘기')
    expect(content).toContain('응답 안 함')
  })

  test('지시문이 chat_id 사용법을 알려 준다', () => {
    expect(INSTRUCTIONS).toContain('chat_id')
    expect(INSTRUCTIONS).toContain('send')
  })
})

/** 코어를 거치지 않고 만든 수신 메시지. 어댑터 층만 볼 때 쓴다. */
function fake(channelId: string, text: string, decision?: Inbound['decision']): Inbound {
  return {
    channelId,
    senderKeyId: new Uint8Array(8).fill(1),
    senderLabel: 'alice',
    text,
    messageId: new Uint8Array(16),
    sentAt: 0n,
    hops: 0,
    decision: decision ?? { speak: true, hops: 1 },
  }
}
