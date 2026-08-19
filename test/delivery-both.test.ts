/**
 * `--delivery both` 수용 테스트 (SCN-1 ~ SCN-9)
 *
 * 정본은 docs/architecture.md §4「전달 방식은 셋이다」· §6.1 · §6.3 · §6.6 이다.
 * 각 테스트 이름 앞에 시나리오 short_code 를 붙여 무엇을 지키는지 추적한다.
 *
 * **구현을 감싸지 않는다.** 확인 지점은 시나리오가 약속한 관찰 가능한 결과이며,
 * 그것을 얻는 경로는 실제 실행 경로 둘 중 하나다.
 *
 *   - `serve()` 를 실제로 띄우고, 주입은 stdio 로 나가는 JSON-RPC 알림을 잡아 본다.
 *     내부 상태를 들여다보는 대신 세션이 실제로 받는 바이트를 본다.
 *   - 배선(SCN-2 · SCN-9)은 `bin.ts` 를 **서브프로세스로 띄워** MCP 로 말을 건다.
 *     `MessageStore` 를 테스트가 직접 만들면 `main()` 의 배선 구멍을 못 잡는다.
 *
 * 홈(`~/.agent-channel-mesh`)은 건드리지 않는다 — 저장소는 임시 디렉토리에 세우고,
 * 서브프로세스에는 `HOME` 을 임시 디렉토리로 넘겨 기본 경로마저 그 안에 가둔다.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentity, generateSeed, deriveIdentity, type Identity } from '../src/identity/keys.js'
import { Channel } from '../src/channel/channel.js'
import { toKey } from '../src/identity/fingerprint.js'
import { MeshNode } from '../src/node/node.js'
import type { RelayClient } from '../src/relay/client.js'
import { MessageStore, type NewMessage, type StoredMessage } from '../src/store/store.js'
import { serve, DEFAULT_COALESCE_MS, type Delivery } from '../src/adapter/server.js'
import { parseArgs } from '../src/adapter/bin.js'
import { callTool } from '../src/adapter/tools.js'
import { BUNDLE_HEAD } from '../src/adapter/bundle.js'
import { CONFIGURE_TOOLS } from '../src/adapter/configure.js'
import { RELAY_CHECK_TOOL, RELAY_EXPORT_TOOL } from '../src/adapter/relay-setup.js'
import { Adapter } from './support/adapter.js'

/** 합류 창. 실제 타이머를 태운다 — 창을 안 태우면 SCN-5 를 확인한 것이 아니다. */
const COALESCE_MS = 500

/** 창이 절대 닫히지 않을 만큼 길게. "저장이 먼저"를 보려면 주입이 아직 없어야 한다. */
const NEVER_MS = 30_000

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

/* ------------------------------------------------------------------ *
 * 하네스
 * ------------------------------------------------------------------ */

/**
 * 릴레이 대역.
 *
 * `poll()` 호출 횟수를 센다 — SCN-3 의 "드레인 루프는 정확히 하나"는
 * 이 값으로만 밖에서 확인된다. 두 경로가 각자 릴레이를 치면 여기가 2가 된다.
 */
class FakeRelay {
  polls = 0
  private readonly queue: Uint8Array[] = []
  private wake?: () => void
  private stopped = false

  push(wire: Uint8Array): void {
    this.queue.push(wire)
    this.wake?.()
  }

  async *poll(): AsyncGenerator<Uint8Array, void, void> {
    this.polls += 1
    while (!this.stopped) {
      while (this.queue.length > 0) {
        if (this.stopped) return
        yield this.queue.shift()!
      }
      await new Promise<void>(resolve => {
        this.wake = resolve
        setTimeout(resolve, 10)
      })
    }
  }

  stop(): void {
    this.stopped = true
    this.wake?.()
  }
}

interface Mesh {
  /** 보내는 쪽(상대). 릴레이가 없으므로 `send` 가 봉투 바이트만 준다. */
  readonly from: MeshNode
  /** 받는 쪽(어댑터가 띄우는 노드). */
  readonly to: MeshNode
  readonly relay: FakeRelay
  readonly id: string
  readonly secret: Uint8Array
}

/** 같은 채널 비밀을 아는 두 노드. `mentions` 를 주면 §7 판정이 실제로 갈린다. */
function mesh(options: { mentions?: readonly string[] } = {}): Mesh {
  const secret = new Channel().secret
  const build = () => {
    const ch = new Channel({ secret, name: '팀룸' })
    ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey, label: 'alice' })
    ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey, label: 'bob' })
    return ch
  }
  const relay = new FakeRelay()
  const from = new MeshNode({ identity: alice })
  const to = new MeshNode({ identity: bob, relay: relay as unknown as RelayClient })
  const id = from.join(build())
  to.join(build(), { mentions: options.mentions })
  return { from, to, relay, id, secret }
}

/** 세션이 실제로 받는 알림. stdio 로 나간 JSON-RPC 를 그대로 파싱한 것이다. */
interface Notification {
  readonly method: string
  readonly params: { readonly content: string; readonly meta: Record<string, string> }
}

let notes: Notification[] = []
let restoreStdout: (() => void) | undefined
let servers: { stop: () => Promise<void> }[] = []
let dir: string
let store: MessageStore

/**
 * 주입 알림을 가로챈다.
 *
 * `serve()` 는 `notify` 를 주입받지 않는다 — MCP 서버의 `notification` 이 곧
 * 주입 경로다. 그래서 관찰 지점도 그 경로의 끝, 즉 stdout 으로 나가는
 * 프레이밍이다. 훅을 끼우는 것보다 이쪽이 "세션에 도달하는 형태"에 가깝다.
 */
function captureStdout(): void {
  const original = process.stdout.write.bind(process.stdout)
  const patched = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    if (text.includes('"notifications/claude/channel"')) {
      for (const line of text.split('\n')) {
        if (line.trim()) notes.push(JSON.parse(line) as Notification)
      }
      return true
    }
    return (original as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
  }
  ;(process.stdout as unknown as { write: unknown }).write = patched
  restoreStdout = () => {
    ;(process.stdout as unknown as { write: unknown }).write = original
  }
}

async function start(node: MeshNode, delivery: Delivery, coalesceMs: number) {
  const server = await serve({ node, delivery, store, coalesceMs })
  servers.push(server)
  return server
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 조건이 설 때까지 기다린다. 시간이 아니라 상태를 기다린다. */
async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('조건이 서지 않았다')
    await sleep(10)
  }
}

/** 저장소에 기록 한 건. 서버 루프가 남기는 것과 같은 모양이다. */
function save(overrides: Partial<NewMessage> & { channelId: string }): Promise<StoredMessage> {
  return store.append({
    direction: 'in',
    axis: 'external',
    senderLabel: 'alice',
    text: '내용',
    sentAt: Date.now(),
    ...overrides,
  })
}

/* ------------------------------------------------------------------ *
 * SCN-1 — 인자 파싱
 * ------------------------------------------------------------------ */

describe('SCN-1 · parseArgs 가 both 를 통과시킨다', () => {
  test('SCN-1 · --delivery both 가 던지지 않고 both 로 통과한다', () => {
    expect(parseArgs(['--delivery', 'both']).delivery).toBe('both')
  })

  test('SCN-1 · push·inbox 도 그대로다 — both 를 더하며 기존 값을 깨지 않는다', () => {
    expect(parseArgs(['--delivery', 'push']).delivery).toBe('push')
    expect(parseArgs(['--delivery', 'inbox']).delivery).toBe('inbox')
  })

  test('SCN-1 · 셋 밖의 값과 누락은 여전히 던진다 — 오타가 조용히 기본값이 되면 안 된다', () => {
    expect(() => parseArgs(['--delivery', 'bath'])).toThrow(/push·inbox·both/)
    expect(() => parseArgs([])).toThrow(/push·inbox·both/)
  })

  test('SCN-1 · ACM_DELIVERY=both 도 통과한다 — 환경변수 경로가 갈리면 안 된다', () => {
    expect(parseArgs([], { ACM_DELIVERY: 'both' }).delivery).toBe('both')
  })
})

/* ------------------------------------------------------------------ *
 * SCN-3 ~ SCN-8 — 실제로 띄운 서버
 * ------------------------------------------------------------------ */

describe('both 로 띄운 서버', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'acm-both-'))
    store = new MessageStore({ dir })
    notes = []
    servers = []
    captureStdout()
  })

  afterEach(async () => {
    for (const s of servers) await s.stop()
    restoreStdout?.()
    restoreStdout = undefined
    await rm(dir, { recursive: true, force: true })
  })

  test('SCN-3 · 릴레이 드레인 루프는 정확히 하나다 (both)', async () => {
    const m = mesh()
    await start(m.to, 'both', COALESCE_MS)
    m.relay.push(await m.from.send(m.id, '한 건'))

    await until(async () => notes.length > 0)
    // 툴 경로가 릴레이를 또 치면 여기서 2가 된다 (§4 — 드레인은 코어 한 곳).
    await callTool({ node: m.to, store, hasInbox: true }, 'inbox', {})

    expect(m.relay.polls).toBe(1)
    // 같은 봉투가 두 경로에 각각 소비되지 않았다 — 기록도 알림도 하나뿐이다.
    expect(await store.read(m.id)).toHaveLength(1)
    expect(notes).toHaveLength(1)
  })

  test('SCN-3 · push·inbox 로 띄워도 드레인 루프는 하나다', async () => {
    for (const delivery of ['push', 'inbox'] as const) {
      const m = mesh()
      await start(m.to, delivery, COALESCE_MS)
      m.relay.push(await m.from.send(m.id, `${delivery} 한 건`))
      await until(async () => (await store.read(m.id)).length === 1)
      expect(m.relay.polls).toBe(1)
      expect(await store.read(m.id)).toHaveLength(1)
    }
  })

  test('SCN-4 · 주입보다 저장이 먼저다 — direction=in 으로 저장소에 있다', async () => {
    const m = mesh()
    // 합류 창을 닫히지 않게 잡아 둔다. 저장이 끝난 시점에 주입은 아직 없어야 한다.
    await start(m.to, 'both', NEVER_MS)
    m.relay.push(await m.from.send(m.id, '먼저 저장'))

    await until(async () => (await store.read(m.id)).length === 1)
    const [saved] = await store.read(m.id)
    expect(saved!.direction).toBe('in')
    expect(saved!.text).toBe('먼저 저장')
    expect(saved!.delivered).toBe(false)
    expect(saved!.senderLabel).toBe('alice')
    // 저장이 끝났는데 주입은 아직이다 — 순서가 반대면 여기서 이미 알림이 있다.
    expect(notes).toHaveLength(0)

    // 기본값(1500ms)보다 넉넉히 더 기다려도 나가지 않는다. 여기까지 봐야
    // "창이 실제로 이 값으로 돈다"가 확인된다 — 창을 무시하고 기본값으로
    // 돌면 이 시점엔 이미 나가 있다. 더 기다릴수록 어긋난 구현이 더 확실히
    // 걸리므로 이 대기는 흔들리지 않는다.
    await sleep(DEFAULT_COALESCE_MS + 300)
    expect(notes).toHaveLength(0)
    expect(await store.undelivered()).toHaveLength(1)
  })

  test('SCN-5 · 창 안에 3건이 오면 주입은 1회, 그 한 건에 3건이 시간순으로 묶인다', async () => {
    const m = mesh()
    // 세 봉투를 **미리** 큐에 넣는다. 창 안에 들어오는 순서를 테스트가
    // 보장해야 하므로, 드레인 사이에 테스트의 대기가 끼지 않게 한다.
    for (const text of ['첫째', '둘째', '셋째']) m.relay.push(await m.from.send(m.id, text))
    await start(m.to, 'both', COALESCE_MS)

    await until(async () => (await store.read(m.id)).length === 3)
    await until(() => notes.length > 0)
    // 창이 한 번 더 돌 만큼 기다려도 두 번째 알림이 없어야 한다.
    await sleep(COALESCE_MS * 2)

    expect(notes).toHaveLength(1)
    const content = notes[0]!.params.content
    expect(content).toContain('첫째')
    expect(content).toContain('둘째')
    expect(content).toContain('셋째')
    expect(content.indexOf('첫째')).toBeLessThan(content.indexOf('둘째'))
    expect(content.indexOf('둘째')).toBeLessThan(content.indexOf('셋째'))
    expect(await store.undelivered()).toHaveLength(0)
  })

  test('SCN-6 · 각 메시지에 발신자·채널·절대 시각이 붙고 머리에 즉답 금지가 들어간다', async () => {
    const m = mesh()
    for (const text of ['앞 말', '뒷 말']) m.relay.push(await m.from.send(m.id, text))
    await start(m.to, 'both', COALESCE_MS)

    await until(() => notes.length > 0)
    const content = notes[0]!.params.content

    // 머리 지시 — §6.1 이 문안까지 정한다.
    expect(content.startsWith(BUNDLE_HEAD)).toBe(true)
    expect(BUNDLE_HEAD).toContain('먼저 전체를 읽고')
    expect(BUNDLE_HEAD).toContain('즉답하지 않는다')

    for (const line of content.split('\n\n').slice(1)) {
      const head = line.split('\n')[0]!
      expect(head).toContain('alice') // 발신자
      expect(head).toContain(m.id) // 채널
      // 절대 시각 둘. `sentAt` 은 발신자가 정하는 값이라 그것만 보이면
      // 발신자가 순서 인식을 조작한다 — 내가 남긴 `storedAt` 이 대조 기준이다.
      expect(head).toMatch(/보낸 \d{4}-\d{2}-\d{2}T[\d:.]+Z/)
      expect(head).toMatch(/저장 \d{4}-\d{2}-\d{2}T[\d:.]+Z/)
    }
    // 상대 시각은 어디에도 없다 (§6.1).
    expect(content).not.toMatch(/\d+\s*(초|분|시간|일|주|개월|년)\s*전/)
    expect(content).not.toMatch(/\bago\b/)
  })

  test('SCN-7 · inbox 는 이미 전달된 것도 보여주고 undelivered() 는 돌려주지 않는다', async () => {
    const m = mesh()
    await start(m.to, 'both', COALESCE_MS)
    m.relay.push(await m.from.send(m.id, '주입된 말'))

    await until(() => notes.length > 0)
    await until(async () => (await store.undelivered()).length === 0)

    const res = await callTool({ node: m.to, store, hasInbox: true }, 'inbox', {})
    // 저장소가 정본이므로 주입된 것도 다시 보인다. 사라지는 것은 새 메시지 표시뿐이다.
    expect(res.text).toContain('주입된 말')
    expect(res.text).not.toContain('새 메시지')
    expect(await store.undelivered()).toHaveLength(0)
  })

  test('SCN-7 · inbox 가 표시한 것은 주입이 다시 쏘지 않는다 — 상태가 막는다', async () => {
    const m = mesh()
    // 창이 닫히기 전에 툴이 먼저 읽어 가는 상황이다.
    await start(m.to, 'both', COALESCE_MS * 4)
    m.relay.push(await m.from.send(m.id, '툴이 먼저 봤다'))

    await until(async () => (await store.read(m.id)).length === 1)
    const res = await callTool({ node: m.to, store, hasInbox: true }, 'inbox', {})
    expect(res.text).toContain('툴이 먼저 봤다')
    expect(res.text).toContain('새 메시지')

    // 창이 닫힐 때까지 기다려도 주입은 나가지 않는다 — 지시문이 아니라
    // `delivered` 상태가 막는다 (§6.6).
    await sleep(COALESCE_MS * 6)
    expect(notes).toHaveLength(0)
  })

  test('SCN-8 · 응답하지 않기로 한 사유가 저장소에 남고 렌더에 보인다', async () => {
    const m = mesh({ mentions: ['bob'] })
    await start(m.to, 'both', COALESCE_MS)
    m.relay.push(await m.from.send(m.id, '남들끼리 하는 얘기'))

    await until(() => notes.length > 0)
    const [saved] = await store.read(m.id)
    // 판정은 도착 시점에만 구할 수 있다 — 기록에 없으면 복원할 수 없다 (§7).
    expect(saved!.mute).toBe('not-mentioned')
    expect(saved!.text).toBe('남들끼리 하는 얘기')
    expect(notes[0]!.params.content).toContain('[응답 안 함: not-mentioned]')
    // 판정과 전달은 분리된다 — 응답하지 않을 메시지도 전달은 된다 (§7).
    expect(notes[0]!.params.content).toContain('남들끼리 하는 얘기')
  })

  test('SCN-8 · 렌더는 기록에서 나온다 — 재계산이면 다르게 나올 값으로 확인한다', async () => {
    const m = mesh({ mentions: ['bob'] })
    // 지금 다시 판정하면 'bob' 이 들어 있어 응답 대상이 된다. 그런데 기록에는
    // 응답 안 함이 남아 있다 — 렌더가 기록을 읽으면 기록이 이긴다.
    await save({ channelId: m.id, text: 'bob 야 이건 재계산이면 갈린다', mute: 'not-mentioned' })

    const res = await callTool({ node: m.to, store, hasInbox: true }, 'inbox', {})
    expect(res.text).toContain('[응답 안 함: not-mentioned]')
  })

  test('[추가검증] 한 알림에 두 채널이 섞이지 않는다 (§6 대화 단위 격리)', async () => {
    const a = mesh()
    const b = mesh()
    // 같은 노드가 두 채널에 붙어 있고, 두 채널 메시지가 한 배치에 들어온다.
    const secondary = new Channel({ secret: b.secret, name: '다른 방' })
    secondary.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey, label: 'alice' })
    secondary.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey, label: 'bob' })
    a.to.join(secondary)

    a.relay.push(await a.from.send(a.id, '에이 채널 말'))
    a.relay.push(await b.from.send(b.id, '비 채널 말'))
    await start(a.to, 'both', COALESCE_MS)

    await until(() => notes.length >= 2, 8000)
    await sleep(COALESCE_MS)

    expect(notes).toHaveLength(2)
    const byChannel = new Map(notes.map(n => [n.params.meta.chat_id!, n.params.content]))
    expect(byChannel.get(a.id)).toContain('에이 채널 말')
    expect(byChannel.get(a.id)).not.toContain('비 채널 말')
    expect(byChannel.get(b.id)).toContain('비 채널 말')
    expect(byChannel.get(b.id)).not.toContain('에이 채널 말')
  })

  test('[추가검증] 주입이 실패하면 delivered 를 찍지 않는다 — 훅 안전망이 잡는다 (§6.6)', async () => {
    const m = mesh()
    await start(m.to, 'both', COALESCE_MS)
    m.relay.push(await m.from.send(m.id, '세션이 없다'))
    await until(async () => (await store.read(m.id)).length === 1)

    // 주입이 나가는 그 순간 전송이 죽는 상황. 세션이 닫혔을 때가 그렇다.
    const failing = () => {
      throw new Error('세션 없음')
    }
    const previous = process.stdout.write
    ;(process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      if (text.includes('"notifications/claude/channel"')) failing()
      return (previous as unknown as (c: unknown, ...r: unknown[]) => boolean).call(
        process.stdout,
        chunk,
        ...rest,
      )
    }
    await sleep(COALESCE_MS * 3)
    ;(process.stdout as unknown as { write: unknown }).write = previous

    // 나가지 않은 것을 전달됐다고 찍으면 그 메시지는 어디에도 도달하지 못한다.
    expect(await store.undelivered()).toHaveLength(1)
    expect(notes).toHaveLength(0)
  })

  test('[추가검증] 앞 묶음이 아직 나가는 중이어도 같은 메시지를 다시 주입하지 않는다 (§6.6)', async () => {
    // 호스트가 파이프를 늦게 읽는 상황. 구현은 아무것도 바꾸지 않았고, 저장소도
    // 진짜다 — 느린 것은 세션 쪽뿐이다. Claude Code 가 바쁘면 실제로 이렇다.
    const STALL_MS = 900
    const WINDOW_MS = 300
    const capture = process.stdout.write
    ;(process.stdout as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      if (text.includes('"notifications/claude/channel"')) {
        notes.push(JSON.parse(text.trim()) as Notification)
        // 쓰기 완료를 늦춘다 — 주입이 창보다 오래 걸리는 상태를 만든다.
        const done = rest.find(r => typeof r === 'function') as ((e?: unknown) => void) | undefined
        if (done) setTimeout(() => done(), STALL_MS)
        return false
      }
      return (capture as unknown as (c: unknown, ...r: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
    }

    const m = mesh()
    await start(m.to, 'both', WINDOW_MS)
    m.relay.push(await m.from.send(m.id, '첫 메시지'))
    // 첫 창이 닫혀 주입이 시작되고, 그것이 아직 끝나기 전에 둘째가 온다.
    await sleep(WINDOW_MS + 100)
    m.relay.push(await m.from.send(m.id, '둘째 메시지'))
    await sleep(STALL_MS + WINDOW_MS * 2)
    ;(process.stdout as unknown as { write: unknown }).write = capture

    // 다음 창이 열릴 때 앞 묶음은 아직 `delivered` 를 찍지 못했다. 상태로
    // 막는다는 약속대로면 그래도 두 번 가지 않아야 한다 — 세션은 같은 말을
    // 두 번 받고, 그것이 지시문이 아니라 상태로 막는다는 §6.6 의 요지다.
    const twice = notes.filter(n => n.params.content.includes('첫 메시지'))
    expect(twice).toHaveLength(1)
  })

  test('[추가검증] send 는 기록에 실패해도 "못 보냈다"고 하지 않는다 — 이미 나갔다', async () => {
    const m = mesh()
    const broken = new Proxy(store, {
      get: (target, prop: keyof MessageStore) =>
        prop === 'append'
          ? async () => {
              throw new Error('디스크 오류')
            }
          : typeof target[prop] === 'function'
            ? (target[prop] as () => unknown).bind(target)
            : target[prop],
    })
    const res = await callTool({ node: m.from, store: broken as MessageStore }, 'send', {
      channel_id: m.id,
      text: '나간 말',
    })
    expect(res.isError).toBeUndefined()
    expect(res.text).toContain('보냈다')
    expect(res.text).toContain('기록 실패')
  })
})

/* ------------------------------------------------------------------ *
 * SCN-2 · SCN-9 — bin.ts 를 실제로 띄워 MCP 로 말을 건다
 * ------------------------------------------------------------------ */

/** hex. 저장 파일 이름이 채널 태그 hex 라서 테스트도 같은 값을 계산한다. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

interface Fixture {
  readonly home: string
  readonly config: string
  readonly storeDir: string
  readonly channelId: string
}

/**
 * 설정 파일을 만든다.
 *
 * `HOME` 까지 임시 디렉토리로 옮긴다 — 배선이 끊겨 기본 경로로 떨어지더라도
 * 사용자의 실제 저장소를 읽거나 표시하지 않게 한다.
 */
async function fixture(store?: Record<string, unknown>): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'acm-both-home-'))
  const other = await createIdentity()
  const secret = new Channel().secret
  const config = join(home, 'config.json')
  const seed = generateSeed()
  await deriveIdentity(seed) // 시드가 실제 신원으로 서는 값인지 확인한다.
  await writeFile(
    config,
    JSON.stringify({
      seed: hex(seed),
      channels: [
        {
          secret: hex(secret),
          name: '팀룸',
          members: [{ label: '상대', sign: hex(other.signPublicKey), kem: hex(other.kemPublicKey) }],
        },
      ],
      ...(store ? { store } : {}),
    }),
    { mode: 0o600 },
  )
  await chmod(config, 0o600)
  return {
    home,
    config,
    storeDir: join(
      (store?.dir as string) ?? join(home, '.agent-channel-mesh/messages'),
      toKey((await deriveIdentity(seed)).fingerprint),
    ),
    channelId: hex(new Channel({ secret }).tag),
  }
}

/** 설정 파일을 아는 어댑터가 내는 툴 이름 전부. 정렬은 `tools/list` 비교용이다. */
function withConfigure(names: readonly string[]): string[] {
  return [
    ...names,
    RELAY_CHECK_TOOL.name,
    RELAY_EXPORT_TOOL.name,
    ...CONFIGURE_TOOLS.map(t => t.name),
  ].sort()
}

describe('bin.ts 를 서브프로세스로 띄운다', () => {
  let homes: string[] = []
  let running: Adapter[] = []

  beforeEach(() => {
    homes = []
    running = []
  })

  afterEach(async () => {
    for (const a of running) await a.stop()
    for (const h of homes) await rm(h, { recursive: true, force: true })
  })

  async function boot(delivery: Delivery, store?: Record<string, unknown>) {
    const fx = await fixture(store)
    homes.push(fx.home)
    const adapter = await Adapter.start(['--delivery', delivery, '--config', fx.config], fx.home)
    running.push(adapter)
    return { fx, adapter }
  }

  test('SCN-2 · both 에서 send·channels·inbox 가 다 실리고 claude/channel 이 선언된다', async () => {
    const { adapter } = await boot('both')

    const capabilities = adapter.initializeResult.capabilities as Record<string, unknown>
    expect(capabilities.experimental).toHaveProperty('claude/channel')

    const names = await adapter.toolNames()
    // whoami 는 전달 방식과 무관하다 — 공개키 교환은 셋 다 필요하다(§11.1).
    // 설정 툴은 `--config` 로 고칠 파일을 아는 한 전달 방식과 무관하게 실린다.
    expect(names).toEqual(withConfigure(['channels', 'inbox', 'send', 'whoami']))
  }, 30_000)

  test('SCN-2 · push 는 inbox 를 싣지 않고, inbox 는 capability 를 선언하지 않는다', async () => {
    const pushed = await boot('push')
    const pushNames = await pushed.adapter.toolNames()
    expect(pushNames).toEqual(withConfigure(['channels', 'send', 'whoami']))
    expect(pushed.adapter.initializeResult.capabilities).toHaveProperty('experimental')

    const polled = await boot('inbox')
    const inboxNames = await polled.adapter.toolNames()
    expect(inboxNames).toEqual(withConfigure(['channels', 'inbox', 'send', 'whoami']))
    // 못 하는 것을 선언하면 호스트가 할 수 있다고 믿는다.
    expect(polled.adapter.initializeResult.capabilities).not.toHaveProperty('experimental')
  }, 30_000)

  test('SCN-9 · 설정의 store.dir·retentionMs 가 실제 MessageStore 에 반영된다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'acm-both-home-'))
    homes.push(home)
    const custom = join(home, '설정이-정한-자리')
    const fx = await fixtureIn(home, { dir: custom, retentionMs: 60_000, maxPerChannel: 2 })

    // 기한을 넘긴 것과 안 넘긴 것을 미리 심는다. 기본값(30일)으로 돌면 둘 다 보인다.
    await seedStore(fx.storeDir, fx.channelId, [
      seeded('11', '기한을 넘긴 말', Date.now() - 600_000),
      seeded('22', '아직 살아 있는 말', Date.now() - 1_000),
    ])

    const adapter = await Adapter.start(['--delivery', 'both', '--config', fx.config], home)
    running.push(adapter)

    const text = await adapter.call('inbox', {})
    // 설정한 자리를 읽었다 = store.dir 배선. 기한 경과분이 사라졌다 = retentionMs 배선.
    expect(text).toContain('아직 살아 있는 말')
    expect(text).not.toContain('기한을 넘긴 말')
  }, 30_000)

  test('SCN-9 · 설정의 store.maxPerChannel 이 실제 MessageStore 에 반영된다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'acm-both-home-'))
    homes.push(home)
    const custom = join(home, 'store')
    const fx = await fixtureIn(home, { dir: custom, retentionMs: 3_600_000, maxPerChannel: 2 })

    const adapter = await Adapter.start(['--delivery', 'both', '--config', fx.config], home)
    running.push(adapter)

    for (const text of ['하나', '둘', '셋']) {
      const res = await adapter.call('send', { channel_id: fx.channelId, text })
      expect(res).toContain('보냈다')
    }

    const file = JSON.parse(await readFile(join(fx.storeDir, `${fx.channelId}.json`), 'utf8')) as {
      messages: { text: string }[]
    }
    // 기본값(2000)으로 돌면 셋이 다 남는다.
    expect(file.messages.map(m => m.text)).toEqual(['둘', '셋'])
  }, 30_000)

  /** `fixture` 와 같지만 홈을 밖에서 준다 — 저장 위치를 미리 심어야 할 때 쓴다. */
  async function fixtureIn(home: string, store: Record<string, unknown>): Promise<Fixture> {
    const other = await createIdentity()
    const secret = new Channel().secret
    const config = join(home, 'config.json')
    const seed = generateSeed()
    const identity = await deriveIdentity(seed)
    await writeFile(
      config,
      JSON.stringify({
        seed: hex(seed),
        channels: [
          {
            secret: hex(secret),
            name: '팀룸',
            members: [
              { label: '상대', sign: hex(other.signPublicKey), kem: hex(other.kemPublicKey) },
            ],
          },
        ],
        store,
      }),
      { mode: 0o600 },
    )
    await chmod(config, 0o600)
    return {
      home,
      config,
      // 설정이 정한 자리가 그대로 저장 위치는 아니다 — 그 아래 지문 한 칸이 붙는다.
      storeDir: join(store.dir as string, toKey(identity.fingerprint)),
      channelId: hex(new Channel({ secret }).tag),
    }
  }
})

/** 저장소 파일 한 건. 저장소가 읽을 형식 그대로다. */
function seeded(id: string, text: string, storedAt: number) {
  return {
    id: id.repeat(8),
    direction: 'in' as const,
    axis: 'external' as const,
    senderLabel: '상대',
    text,
    sentAt: storedAt,
    storedAt,
    delivered: false,
  }
}

/** 저장 디렉토리를 만들고 파일을 심는다. 권한은 저장소가 요구하는 그대로다. */
async function seedStore(
  dirPath: string,
  channelId: string,
  messages: ReturnType<typeof seeded>[],
): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 })
  await chmod(dirPath, 0o700)
  const file = join(dirPath, `${channelId}.json`)
  await writeFile(file, JSON.stringify({ version: 1, channelId, messages: messages.map(m => ({ ...m, channelId })) }), {
    mode: 0o600,
  })
  await chmod(file, 0o600)
}
