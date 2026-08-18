/**
 * 어댑터 테스트
 *
 * 어댑터의 계약은 두 방향뿐이다(§4). 세션→메시는 두 어댑터가 공유하므로
 * 한 번만 확인하고, 메시→세션은 갈리는 지점이라 각각 확인한다.
 *
 * 가장 중요한 확인은 **경계**다 — 어댑터가 코어를 우회해 암호나 정책을
 * 스스로 조립하지 않는가. 그래서 발화 제어가 툴 경로에서도 살아 있는지를
 * 본다: 모델이 툴을 직접 부르는 길이 예산 우회로가 되면 §7 이 무너진다.
 *
 * 읽는 쪽의 정본은 **로컬 저장소**다(§6.3) — 릴레이가 아니다. 그래서 툴
 * 테스트도 메모리 수신함이 아니라 실제 저장소를 세워 놓고 본다.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { Channel } from '../src/channel/channel.js'
import { MeshNode, type Inbound } from '../src/node/node.js'
import { MessageStore, type NewMessage, type StoredMessage } from '../src/store/store.js'
import { callTool } from '../src/adapter/tools.js'
import { ClaudeAdapter, CAPABILITIES, INSTRUCTIONS } from '../src/adapter/claude.js'

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

/** 홈의 실제 저장소를 절대 건드리지 않는다 — 테스트마다 임시 디렉토리를 판다. */
let dir: string
let store: MessageStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-adapter-'))
  store = new MessageStore({ dir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 코어를 거치지 않는 채널 id. 저장소는 경로 조각이 되므로 hex 만 받는다. */
const CH = 'aa11'
const CH2 = 'bb22'

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

/** 저장소에 도착 기록 한 건을 남긴다. 서버 루프가 하는 일과 같은 모양이다. */
function save(overrides: Partial<NewMessage> = {}): Promise<StoredMessage> {
  return store.append({
    channelId: CH,
    direction: 'in',
    axis: 'external',
    senderLabel: 'alice',
    text: '내용',
    sentAt: Date.now(),
    ...overrides,
  })
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
          : typeof t[p] === 'function'
            ? (t[p] as () => unknown).bind(t)
            : t[p],
    })
    const res = await callTool({ node: spy as MeshNode, store }, 'send', {
      channel_id: id,
      text: '툴로 보냄',
    })
    expect(res.isError).toBeUndefined()
    expect(inbound(await nodeB.accept(sent!)).text).toBe('툴로 보냄')
  })

  test('보낸 것도 저장소에 남는다 — 조망 UI 는 내 발화도 본다 (§6.3)', async () => {
    const { nodeA, id } = pair()
    await callTool({ node: nodeA, store }, 'send', { channel_id: id, text: '내가 보냄' })

    const [saved] = await store.read(id)
    expect(saved!.direction).toBe('out')
    expect(saved!.text).toBe('내가 보냄')
    // 나가는 것은 주입 대상이 아니므로 처음부터 전달된 것으로 친다 (§6.6).
    expect(await store.undelivered(id)).toHaveLength(0)
  })

  test('붙지 않은 채널은 오류를 돌려준다 — 던지지 않는다', async () => {
    const { nodeA } = pair()
    const res = await callTool({ node: nodeA, store }, 'send', { channel_id: '없음', text: 'x' })
    expect(res.isError).toBe(true)
  })

  test('인자가 없으면 오류다', async () => {
    const { nodeA, id } = pair()
    expect((await callTool({ node: nodeA, store }, 'send', { channel_id: id })).isError).toBe(true)
    expect((await callTool({ node: nodeA, store }, 'send', { text: 'x' })).isError).toBe(true)
  })

  test('모르는 툴은 오류다', async () => {
    const { nodeA } = pair()
    expect((await callTool({ node: nodeA, store }, '없는툴', {})).isError).toBe(true)
  })

  test('예산이 소진되면 툴이 거부한다 — 모델의 우회로를 막는다', async () => {
    const { nodeA, id } = pair({ budget: 1 })
    expect(
      (await callTool({ node: nodeA, store }, 'send', { channel_id: id, text: '1' })).isError,
    ).toBeUndefined()
    const second = await callTool({ node: nodeA, store }, 'send', { channel_id: id, text: '2' })
    expect(second.isError).toBe(true)
    expect(second.text).toMatch(/예산/)
  })

  test('channels 가 멤버와 지문을 보여준다', async () => {
    const { nodeA, id } = pair()
    const res = await callTool({ node: nodeA, store }, 'channels', {})
    expect(res.text).toContain('팀룸')
    expect(res.text).toContain(id)
    expect(res.text).toContain('alice')
    // 지문은 128비트 전체다 — 잘라 보여주지 않는다 (§9).
    // `toHex` 가 읽기 쉽게 4자씩 끊으므로 그 형태로 확인한다.
    expect(res.text).toMatch(/fp (?:[0-9a-f]{4} ){7}[0-9a-f]{4}/)
  })

  test('붙은 채널이 없으면 그렇게 말한다', async () => {
    const empty = new MeshNode({ identity: alice })
    expect((await callTool({ node: empty, store }, 'channels', {})).text).toContain('없다')
  })

  test('whoami 가 공개키와 지문을 낸다', async () => {
    // 어댑터는 이 값을 stderr 로만 내는데 사람은 그 화면을 보지 못한다.
    // 세션 안에 꺼낼 자리가 없으면 공개키 교환이 시작되지 않는다.
    const res = await callTool({ node: new MeshNode({ identity: alice }), store }, 'whoami', {
      label: 'alice',
    })
    expect(res.isError).toBeFalsy()
    expect(res.text).toContain('members')
    expect(res.text).toContain('alice')
    expect(res.text).toMatch(/fp: (?:[0-9a-f]{4} ){7}[0-9a-f]{4}/)
  })

  test('whoami 가 시드를 내지 않는다', async () => {
    // 툴 응답은 모델 컨텍스트로 들어가고, 그 컨텍스트는 로그·요약을 거친다.
    const node = new MeshNode({ identity: alice })
    const res = await callTool({ node, store }, 'whoami', {})
    const seed = Array.from(alice.seed, b => b.toString(16).padStart(2, '0')).join('')
    expect(res.text).not.toContain(seed)
  })
})

describe('inbox 툴 — 저장소를 꺼내 간다', () => {
  const ctx = () => ({ node: new MeshNode({ identity: bob }), store, hasInbox: true })

  test('저장된 것을 꺼낸다', async () => {
    const { nodeA, nodeB, id } = pair()
    const got = inbound(await nodeB.accept(await nodeA.send(id, '첫 메시지')))
    await save({ channelId: id, text: got.text, senderLabel: got.senderLabel })

    const res = await callTool(ctx(), 'inbox', {})
    expect(res.text).toContain('첫 메시지')
    expect(res.text).toContain('alice')
  })

  test('읽으면 전달 표시가 된다 — 훅이 같은 것을 다시 들이밀지 않게 (§6.6)', async () => {
    await save({ text: '한 번만' })

    const first = await callTool(ctx(), 'inbox', {})
    expect(first.text).toContain('한 번만')
    expect(first.text).toContain('새 메시지')
    expect(await store.undelivered()).toHaveLength(0)

    // 저장소가 정본이므로 **다시 보인다** — 사라지는 것은 새 메시지 표시뿐이다.
    const second = await callTool(ctx(), 'inbox', {})
    expect(second.text).toContain('한 번만')
    expect(second.text).not.toContain('새 메시지')
  })

  test('채널별로 격리해 읽는다 — §6', async () => {
    await save({ channelId: CH, text: '에이 내용' })
    await save({ channelId: CH2, text: '비 내용' })

    const res = await callTool(ctx(), 'inbox', { channel_id: CH })
    expect(res.text).toContain('에이 내용')
    expect(res.text).not.toContain('비 내용')
    // 다른 채널 것은 여전히 미전달로 남는다.
    expect(await store.undelivered(CH2)).toHaveLength(1)
  })

  test('안 읽은 개수는 저장소의 전달 상태로 센다', async () => {
    const { nodeA, id } = pair()
    await save({ channelId: id, text: '1' })
    await save({ channelId: id, text: '2' })

    expect((await callTool({ node: nodeA, store }, 'channels', {})).text).toContain('안 읽음 2')
    await callTool({ node: nodeA, store, hasInbox: true }, 'inbox', {})
    expect((await callTool({ node: nodeA, store }, 'channels', {})).text).toContain('안 읽음 0')
  })

  test('limit 은 최신 쪽을 남긴다 — 방금 온 말을 못 보면 안 된다', async () => {
    for (let i = 0; i < 5; i++) await save({ text: `${i}` })
    const res = await callTool(ctx(), 'inbox', { limit: 2 })
    expect(res.text).toContain('3')
    expect(res.text).toContain('4')
    expect(res.text).not.toContain('\n0')
  })

  test('내가 보낸 것은 돌려주지 않는다 — 도착한 메시지가 아니다', async () => {
    await save({ direction: 'out', text: '내 발화', senderLabel: undefined })
    expect((await callTool(ctx(), 'inbox', {})).text).toContain('새 메시지가 없다')
  })

  test('응답하지 않을 메시지도 읽히되 표시가 붙는다 — §7', async () => {
    await save({ text: '남 얘기', mute: 'not-mentioned' })
    const res = await callTool(ctx(), 'inbox', {})
    expect(res.text).toContain('남 얘기')
    expect(res.text).toContain('응답 안 함')
  })

  test('수신함이 없는 어댑터에서 inbox 는 오류다', async () => {
    const res = await callTool({ node: new MeshNode({ identity: bob }), store }, 'inbox', {})
    expect(res.isError).toBe(true)
  })
})

describe('Claude 어댑터 — 능동 주입', () => {
  test('capability 를 선언한다', () => {
    expect(CAPABILITIES.experimental).toHaveProperty('claude/channel')
  })

  test('meta 키에 하이픈이 없다 — 조용히 삭제되는 값이다', async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = []
    const adapter = new ClaudeAdapter({ notify: async n => void sent.push(n) })
    const delivered = await adapter.inject([record({ text: '주입 확인' })])

    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
    const meta = sent[0]!.params.meta as Record<string, string>
    for (const key of Object.keys(meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/)
    expect(meta.chat_id).toBe(CH)
    expect(meta.sender).toBe('alice')
    // 실제로 나간 것만 돌려준다 — 호출자는 이걸로만 전달 표시를 찍는다.
    expect(delivered).toEqual(['ab12'])
  })

  test('본문과 발신자를 함께 넣는다', async () => {
    let content = ''
    const adapter = new ClaudeAdapter({
      notify: async n => void (content = n.params.content as string),
    })
    await adapter.inject([record({ text: '내용입니다' })])
    expect(content).toContain('alice')
    expect(content).toContain('내용입니다')
  })

  test('응답하지 않을 메시지도 주입된다 — 필터링이 아니다', async () => {
    let content = ''
    const adapter = new ClaudeAdapter({
      notify: async n => void (content = n.params.content as string),
    })
    await adapter.inject([record({ text: '남 얘기', mute: 'not-mentioned' })])
    expect(content).toContain('남 얘기')
    expect(content).toContain('응답 안 함')
  })

  test('채널이 다르면 알림도 갈린다 — meta.chat_id 는 하나뿐이다', async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = []
    const adapter = new ClaudeAdapter({ notify: async n => void sent.push(n) })
    await adapter.inject([
      record({ id: 'ab12', channelId: CH, text: '에이' }),
      record({ id: 'cd34', channelId: CH2, text: '비' }),
    ])

    expect(sent).toHaveLength(2)
    const targets = sent.map(n => (n.params.meta as Record<string, string>).chat_id)
    expect(targets).toEqual([CH, CH2])
  })

  test('한 채널이 실패해도 나머지는 나가고, 실패분은 미전달로 남는다 (§6.6)', async () => {
    const errors: unknown[] = []
    const adapter = new ClaudeAdapter({
      notify: async n => {
        if ((n.params.meta as Record<string, string>).chat_id === CH) throw new Error('세션 없음')
      },
      onError: e => void errors.push(e),
    })
    const delivered = await adapter.inject([
      record({ id: 'ab12', channelId: CH, text: '에이' }),
      record({ id: 'cd34', channelId: CH2, text: '비' }),
    ])

    expect(delivered).toEqual(['cd34'])
    expect(errors).toHaveLength(1)
  })

  test('지시문이 chat_id 사용법을 알려 준다', () => {
    expect(INSTRUCTIONS).toContain('chat_id')
    expect(INSTRUCTIONS).toContain('send')
  })
})

/** 저장소를 거치지 않고 만든 기록. 어댑터 층만 볼 때 쓴다. */
function record(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'ab12',
    channelId: CH,
    direction: 'in',
    axis: 'external',
    senderKeyId: '0101010101010101',
    senderLabel: 'alice',
    text: '내용',
    sentAt: 0,
    storedAt: 0,
    delivered: false,
    ...overrides,
  }
}
