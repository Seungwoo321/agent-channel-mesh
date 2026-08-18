/**
 * 어댑터 드레인의 선점(리스) 인수 테스트 — 독립 검증
 *
 * 검증 대상은 `src/adapter/server.ts` 의 `drain`·`settle`·`stop` 이다. 주장은
 * 하나다: **어댑터와 훅이 별개 프로세스로 같은 저장소를 동시에 봐도 같은
 * 메시지가 두 번 전달되지 않는다.**
 *
 * 그래서 이 파일의 1부는 **진짜 서브프로세스 두 개**를 띄운다. 한 프로세스
 * 안의 `Promise.all` 은 이벤트 루프가 직렬이라 잠금이 없어도 통과하므로
 * 증명이 되지 못한다. 출발선은 ready/go 파일로 맞춘다 — 늦게 뜬 쪽이 빈 큐를
 * 보면 "중복 0" 이 공허하게 통과하기 때문에, **양쪽이 실제로 집었는지**
 * (`min(A,B) > 0`)를 함께 단언한다.
 *
 * 그리고 이 하네스가 중복을 **실제로 탐지할 수 있는지**를 음성 대조군으로
 * 확인한다 — 같은 시나리오를 선점 없이(`undelivered()`) 돌리면 중복이 나와야
 * 한다. 안 나오면 1부가 아무것도 검증하지 못한 것이다.
 *
 * 2부(실패·종료 경로)는 한 프로세스 안이다. 그 성질들은 프로세스 사이의
 * 배타가 아니라 **한 드레인의 정리 순서**에 관한 것이라, 관찰 지점도 그 안에
 * 있다. 관찰은 여전히 밖에서 한다 — 주입은 stdout 으로 나가는 JSON-RPC 를
 * 잡아 보고, 상태는 저장소 파일을 읽는다.
 *
 * 워커 스크립트는 이 파일이 임시 디렉토리에 직접 만든다. `test/workers/` 의
 * 기존 자산을 쓰지 않는다 — 구현자가 만든 것이라 같은 오해를 공유한다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore, type StoredMessage } from '../src/store/store.js'
import { serve, STOP_SETTLE_MS } from '../src/adapter/server.js'
import type { Inbound, MeshNode } from '../src/node/node.js'

const REPO = join(import.meta.dir, '..')

const A = 'aa11'
const B = 'bb22'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 시간이 아니라 상태를 기다린다. */
async function until(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
  what = '조건',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`${what} 이(가) 서지 않았다`)
    await sleep(5)
  }
}

/* ================================================================== *
 * 1부 — 별개 프로세스 두 개가 같은 저장소를 동시에 친다
 * ================================================================== */

/**
 * 어댑터 쪽 워커.
 *
 * `claim` 모드는 **실제 `serve()`** 를 띄운다 — 드레인·정리·종료가 전부
 * `src/adapter/server.ts` 의 것이다. 세션이 받는 것은 stdio 로 나가는
 * `notifications/claude/channel` 이므로, 부모는 그 바이트만 본다.
 *
 * `naive` 모드는 음성 대조군이다. 같은 `ClaudeAdapter`·같은 합류 창을 쓰되
 * 선점 대신 조회(`undelivered`)로 집는다 — 딱 한 군데만 다르다.
 */
function adapterWorkerSource(repo: string): string {
  return [
    "import { writeFile } from 'node:fs/promises'",
    "import { existsSync } from 'node:fs'",
    "import { MessageStore } from '" + repo + "/src/store/store.js'",
    "import { serve } from '" + repo + "/src/adapter/server.js'",
    "import { ClaudeAdapter } from '" + repo + "/src/adapter/claude.js'",
    "import { hex } from '" + repo + "/src/adapter/bundle.js'",
    "import type { MeshNode } from '" + repo + "/src/node/node.js'",
    '',
    'const [mode, dir, ready, go, channelsRaw, perRaw, coalesceRaw, gapRaw] = process.argv.slice(2)',
    'const channels = String(channelsRaw).split(",")',
    'const per = Number(perRaw)',
    'const coalesceMs = Number(coalesceRaw)',
    'const gapMs = Number(gapRaw)',
    '',
    'const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))',
    'function idBytes(): Uint8Array { const b = new Uint8Array(16); crypto.getRandomValues(b); return b }',
    '',
    'const plan: { channelId: string; token: string }[] = []',
    'let seq = 0',
    'for (let i = 0; i < per; i += 1) {',
    '  for (const c of channels) {',
    '    plan.push({ channelId: c, token: "T" + String(seq).padStart(4, "0") })',
    '    seq += 1',
    '  }',
    '}',
    '',
    'const node = {',
    '  axisOf: () => "external" as const,',
    '  stop: () => {},',
    '  listen: async function* () {',
    '    for (const p of plan) {',
    '      yield {',
    '        channelId: p.channelId,',
    '        senderKeyId: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),',
    '        senderLabel: "alice",',
    '        text: p.token,',
    '        messageId: idBytes(),',
    '        sentAt: BigInt(Date.now()),',
    '        hops: 0,',
    '        decision: { speak: true as const, hops: 0 },',
    '      }',
    '      await sleep(gapMs)',
    '    }',
    '  },',
    '}',
    '',
    'const store = new MessageStore({ dir: String(dir) })',
    '',
    'await writeFile(String(ready), String(process.pid))',
    'while (!existsSync(String(go))) await sleep(1)',
    '',
    'if (mode === "claim") {',
    '  const server = await serve({ node: node as unknown as MeshNode, delivery: "push", store, coalesceMs })',
    '  await sleep(gapMs * plan.length + coalesceMs * 8 + 400)',
    '  await server.stop()',
    '} else {',
    '  // 대조군: 선점 대신 조회. 나머지(합류 창·어댑터·표시)는 같다.',
    '  const adapter = new ClaudeAdapter({',
    '    notify: async n => { process.stdout.write(JSON.stringify(n) + "\\n") },',
    '  })',
    '  let timer: ReturnType<typeof setTimeout> | undefined',
    '  let inFlight: Promise<void> = Promise.resolve()',
    '  const drain = async () => {',
    '    const batch = await store.undelivered()',
    '    if (batch.length === 0) return',
    '    const delivered = await adapter.inject(batch)',
    '    await store.markDelivered(delivered)',
    '  }',
    '  const flush = () => { inFlight = inFlight.then(drain).catch(() => {}); return inFlight }',
    '  const schedule = () => {',
    '    if (timer !== undefined) return',
    '    timer = setTimeout(() => { timer = undefined; void flush() }, coalesceMs)',
    '  }',
    '  for await (const m of node.listen()) {',
    '    await store.append({',
    '      id: hex(m.messageId),',
    '      channelId: m.channelId,',
    '      direction: "in",',
    '      axis: "external",',
    '      senderKeyId: hex(m.senderKeyId),',
    '      senderLabel: m.senderLabel,',
    '      text: m.text,',
    '      sentAt: Number(m.sentAt),',
    '      hops: m.hops,',
    '    })',
    '    schedule()',
    '  }',
    '  await sleep(coalesceMs * 8 + 400)',
    '  if (timer !== undefined) clearTimeout(timer)',
    '  await inFlight',
    '}',
    '',
  ].join('\n')
}

/**
 * 훅 쪽 워커 (§6.6 안전망 시뮬레이터).
 *
 * 별개 프로세스로 같은 저장소를 보고, 집어서 "전달"하고 표시한다. 전달한
 * 토큰을 stdout 으로 낸다 — 부모가 어댑터 쪽 토큰과 합쳐 교집합을 센다.
 */
function hookWorkerSource(repo: string): string {
  return [
    "import { writeFile } from 'node:fs/promises'",
    "import { existsSync } from 'node:fs'",
    "import { MessageStore } from '" + repo + "/src/store/store.js'",
    '',
    'const [mode, dir, ready, go, stopFile, batchRaw, pollRaw] = process.argv.slice(2)',
    'const batchSize = Number(batchRaw)',
    'const pollMs = Number(pollRaw)',
    'const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))',
    '',
    'const store = new MessageStore({ dir: String(dir) })',
    'await writeFile(String(ready), String(process.pid))',
    'while (!existsSync(String(go))) await sleep(1)',
    '',
    'const took: string[] = []',
    'const deadline = Date.now() + 40_000',
    'for (;;) {',
    '  const batch =',
    '    mode === "claim"',
    '      ? await store.claimUndelivered(undefined, batchSize)',
    '      : await store.undelivered(undefined, batchSize)',
    '  if (batch.length > 0) {',
    '    // "전달"이 먼저, 표시가 나중 — 어댑터와 같은 순서다.',
    '    for (const m of batch) took.push(m.text)',
    '    await store.markDelivered(batch.map(m => m.id))',
    '  }',
    '  if (batch.length === 0 && existsSync(String(stopFile))) break',
    '  if (Date.now() > deadline) break',
    '  await sleep(pollMs)',
    '}',
    '',
    'process.stdout.write(took.join("\\n") + "\\n")',
    '',
  ].join('\n')
}

interface RaceResult {
  readonly adapterTokens: string[]
  readonly hookTokens: string[]
  readonly adapterCode: number
  readonly hookCode: number
  readonly leftover: readonly StoredMessage[]
  readonly stillClaimed: readonly StoredMessage[]
  readonly all: string[]
}

/** 토큰은 본문이 곧 id 다 — 렌더에도 그대로 실린다. */
const TOKEN = /T\d{4}/g

async function finish(proc: ReturnType<typeof Bun.spawn>) {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  return { code, stdout, stderr }
}

/**
 * 두 프로세스를 같은 출발선에 세우고 같은 저장소를 치게 한다.
 *
 * `mode` 만 갈린다 — `claim` 은 실제 `serve()`, `naive` 는 같은 모양의
 * 선점 없는 드레인이다.
 */
async function race(
  mode: 'claim' | 'naive',
  options: { channels?: string[]; per?: number; coalesceMs?: number; gapMs?: number } = {},
): Promise<RaceResult> {
  const channels = options.channels ?? [A, B]
  const per = options.per ?? 30
  const coalesceMs = options.coalesceMs ?? 25
  const gapMs = options.gapMs ?? 4

  const root = await mkdtemp(join(tmpdir(), `acm-claim-${mode}-`))
  const storeDir = join(root, 'store')
  const adapterPath = join(root, 'adapter-worker.ts')
  const hookPath = join(root, 'hook-worker.ts')
  const readyA = join(root, 'ready-adapter')
  const readyB = join(root, 'ready-hook')
  const go = join(root, 'go')
  const stopFile = join(root, 'stop')

  await writeFile(adapterPath, adapterWorkerSource(REPO))
  await writeFile(hookPath, hookWorkerSource(REPO))

  const adapterProc = Bun.spawn({
    cmd: [
      'bun',
      'run',
      adapterPath,
      mode,
      storeDir,
      readyA,
      go,
      channels.join(','),
      String(per),
      String(coalesceMs),
      String(gapMs),
    ],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const hookProc = Bun.spawn({
    cmd: ['bun', 'run', hookPath, mode, storeDir, readyB, go, stopFile, '4', '3'],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    // 랑데부. 둘 다 모듈을 다 읽고 손을 든 뒤에야 출발시킨다.
    await until(() => existsSync(readyA) && existsSync(readyB), 30_000, '워커 준비')
    await writeFile(go, '1')

    const adapter = await finish(adapterProc)
    await writeFile(stopFile, '1')
    const hook = await finish(hookProc)

    const store = new MessageStore({ dir: storeDir })
    const leftover = await store.undelivered()
    const stillClaimed: StoredMessage[] = []
    for (const id of await store.channels()) {
      for (const m of await store.read(id)) if (m.claimedAt !== undefined) stillClaimed.push(m)
    }

    const all: string[] = []
    for (let i = 0; i < per * channels.length; i += 1) all.push('T' + String(i).padStart(4, '0'))

    return {
      adapterTokens: adapter.stdout.match(TOKEN) ?? [],
      hookTokens: hook.stdout.match(TOKEN) ?? [],
      adapterCode: adapter.code,
      hookCode: hook.code,
      leftover,
      stillClaimed,
      all,
    }
  } finally {
    adapterProc.kill()
    hookProc.kill()
    await rm(root, { recursive: true, force: true })
  }
}

/** 측정치를 눈으로 확인할 때만 켠다. ACM_VERIFY_DUMP=1 */
function dump(mode: string, r: RaceResult): void {
  if (process.env.ACM_VERIFY_DUMP !== '1') return
  const a = new Set(r.adapterTokens)
  const b = new Set(r.hookTokens)
  console.error(
    `[${mode}] adapter=${r.adapterTokens.length}(distinct ${a.size}) ` +
      `hook=${r.hookTokens.length}(distinct ${b.size}) ` +
      `union=${new Set([...a, ...b]).size}/${r.all.length} ` +
      `dup=${duplicates(r).length} leftover=${r.leftover.length} ` +
      `claimed=${r.stillClaimed.length} exit=${r.adapterCode}/${r.hookCode}`,
  )
}

/** 전체 전달에서 두 번 이상 나간 토큰. 이것이 곧 "같은 말이 두 번" 이다. */
function duplicates(result: RaceResult): { token: string; times: number }[] {
  const counts = new Map<string, number>()
  for (const t of [...result.adapterTokens, ...result.hookTokens]) {
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, n]) => n > 1)
    .map(([token, times]) => ({ token, times }))
    .sort((a, b) => a.token.localeCompare(b.token))
}

describe('별개 프로세스 두 개가 같은 저장소를 동시에 드레인한다', () => {
  test('선점: 한 메시지는 정확히 한쪽에만 잡힌다 (교집합 0 · 합집합 전체)', async () => {
    const r = await race('claim')
    dump('claim', r)

    expect(r.adapterCode).toBe(0)
    expect(r.hookCode).toBe(0)

    const a = new Set(r.adapterTokens)
    const b = new Set(r.hookTokens)

    // 경합이 실제로 있었나. 한쪽이 0 이면 "중복 0" 은 아무 뜻이 없다.
    expect(Math.min(a.size, b.size)).toBeGreaterThan(0)

    // 각자 안에서도 두 번 나가지 않았다.
    expect(r.adapterTokens).toHaveLength(a.size)
    expect(r.hookTokens).toHaveLength(b.size)

    // 교집합 0 — 같은 말이 두 번 가지 않았다.
    expect([...a].filter(t => b.has(t))).toEqual([])
    expect(duplicates(r)).toEqual([])

    // 합집합 = 전체. 배타를 유실로 사지 않았다.
    expect(new Set([...a, ...b]).size).toBe(r.all.length)
    expect(r.leftover).toHaveLength(0)
    expect(r.stillClaimed).toHaveLength(0)
  }, 60_000)

  test('음성 대조군: 선점 없이 같은 시나리오를 돌리면 중복이 실제로 난다', async () => {
    const r = await race('naive')
    dump('naive', r)

    // 대조군은 조용히 실패한다 — 종료 코드로는 아무것도 알 수 없다.
    expect(r.adapterCode).toBe(0)
    expect(r.hookCode).toBe(0)

    const a = new Set(r.adapterTokens)
    const b = new Set(r.hookTokens)
    expect(Math.min(a.size, b.size)).toBeGreaterThan(0)

    // 이 단언이 1부의 "중복 0" 을 의미 있게 만든다. 여기서 0 이 나오면
    // 하네스가 중복을 탐지하지 못한다는 뜻이므로 하네스를 고쳐야 한다.
    expect(duplicates(r).length).toBeGreaterThan(0)
  }, 60_000)
})

/* ================================================================== *
 * 2부 — 실패·종료 경로 (한 프로세스, 실제 serve)
 * ================================================================== */

/** stdout 으로 나가는 알림을 어떻게 다룰지. */
type Verdict = 'pass' | 'throw' | 'block'

let dir: string
let store: MessageStore
let notes: string[] = []
let errs: string[] = []
let policy: (text: string) => Verdict = () => 'pass'
let restore: (() => void) | undefined
let servers: { stop: () => Promise<void> }[] = []

/**
 * 주입 경로의 끝(stdout)과 진단 경로의 끝(stderr)을 잡는다.
 *
 * `serve()` 는 주입 함수를 주입받지 않는다 — MCP `notification` 이 곧 주입
 * 경로다. 그래서 실패도 그 경로에서 만든다: 던지면 그 채널의 주입이 실패하고,
 * `false` 를 주면 전송이 `drain` 을 기다리며 멈춘다(파이프가 막힌 상태).
 */
function capture(): void {
  const outOriginal = process.stdout.write.bind(process.stdout)
  const errOriginal = process.stderr.write.bind(process.stderr)

  const patchedOut = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    if (text.includes('"notifications/claude/channel"')) {
      notes.push(text)
      const verdict = policy(text)
      if (verdict === 'throw') throw new Error('세션 없음')
      if (verdict === 'block') return false // 전송이 'drain' 을 기다린다
      return true
    }
    return (outOriginal as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
  }
  const patchedErr = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    if (text.startsWith('[agent-channel-mesh]')) {
      errs.push(text)
      return true
    }
    return (errOriginal as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
  }

  ;(process.stdout as unknown as { write: unknown }).write = patchedOut
  ;(process.stderr as unknown as { write: unknown }).write = patchedErr
  restore = () => {
    ;(process.stdout as unknown as { write: unknown }).write = outOriginal
    ;(process.stderr as unknown as { write: unknown }).write = errOriginal
  }
}

/** 테스트가 도착을 직접 조종하는 노드. 릴레이·암호는 이 검증의 대상이 아니다. */
function pushNode() {
  const queue: Inbound[] = []
  let wake: (() => void) | undefined
  let closed = false

  const node = {
    axisOf: () => 'external' as const,
    stop: () => {
      closed = true
      wake?.()
    },
    listen: async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (closed) return
        await new Promise<void>(resolve => {
          wake = resolve
          setTimeout(resolve, 5)
        })
      }
    },
  }

  return {
    node: node as unknown as MeshNode,
    push(channelId: string, text: string): void {
      const messageId = new Uint8Array(16)
      crypto.getRandomValues(messageId)
      queue.push({
        channelId,
        senderKeyId: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        senderLabel: 'alice',
        // 동료가 보낸 것으로 둔다 — 이 스텁이 흉내 내는 것은 인바운드다 (§8).
        authority: 'peer',
        grant: 'read',
        text,
        messageId,
        sentAt: BigInt(Date.now()),
        hops: 0,
        decision: { speak: true, hops: 0 },
      })
      wake?.()
    },
  }
}

async function start(node: MeshNode, coalesceMs: number, s: MessageStore = store) {
  const server = await serve({ node, delivery: 'push', store: s, coalesceMs })
  servers.push(server)
  return server
}

/** 저장소에 실제로 남은 것. 상태 판정은 전부 여기서 읽는다. */
async function recordOf(channelId: string, text: string): Promise<StoredMessage | undefined> {
  const messages = await store.read(channelId)
  return messages.find(m => m.text === text)
}

async function claimedCount(): Promise<number> {
  let n = 0
  for (const id of await store.channels()) {
    for (const m of await store.read(id)) if (m.claimedAt !== undefined) n += 1
  }
  return n
}

/**
 * 주입은 던지고 정리도 던지는 저장소.
 *
 * `channelId` 접근에서 던지므로 `inject` 안의 `groupByChannel` 이 통째로
 * 던진다 — 채널별 `try` 보다 바깥이라 `inject` 자체가 실패하는 경로다.
 * 정리(`release`)까지 던지게 하면 §"settle 이 실패해도 원래 예외가 덮이지
 * 않는다" 를 볼 수 있다.
 */
class PoisonStore extends MessageStore {
  releaseThrows = false

  override async claimUndelivered(
    channelId?: string,
    limit?: number,
  ): Promise<readonly StoredMessage[]> {
    const real = await super.claimUndelivered(channelId, limit)
    return real.map(
      m =>
        new Proxy(m, {
          get: (target, prop, receiver) => {
            if (prop === 'channelId') throw new Error('독')
            return Reflect.get(target, prop, receiver) as unknown
          },
        }) as StoredMessage,
    )
  }

  override async release(ids: readonly string[]): Promise<number> {
    if (this.releaseThrows) throw new Error('정리 실패')
    return super.release(ids)
  }
}

describe('실패·종료 경로 (실제 serve, 저장소는 디스크)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'acm-claim-unit-'))
    store = new MessageStore({ dir })
    notes = []
    errs = []
    policy = () => 'pass'
    servers = []
    capture()
  })

  afterEach(async () => {
    // 막아 둔 전송을 풀어 준다 — 안 풀면 대기 중인 프라미스가 남는다.
    policy = () => 'pass'
    process.stdout.emit('drain')
    for (const s of servers) {
      try {
        await s.stop()
      } catch {
        // 이미 멈춘 서버다.
      }
    }
    restore?.()
    restore = undefined
    await rm(dir, { recursive: true, force: true })
  })

  test('일부 채널이 실패하면 나간 것만 delivered 이고 못 나간 것은 즉시 풀린다', async () => {
    const feed = pushNode()
    policy = text => (text.includes(B) ? 'throw' : 'pass')
    await start(feed.node, 60)

    feed.push(A, '가는 것')
    feed.push(B, '못 가는 것')

    await until(async () => (await recordOf(A, '가는 것'))?.delivered === true, 10_000, '주입')
    // 정리는 주입 직후다. 같은 묶음이므로 B 의 판정도 이 시점에 끝나 있다.
    await until(async () => (await recordOf(B, '못 가는 것'))?.claimedAt === undefined)

    const sent = await recordOf(A, '가는 것')
    const failed = await recordOf(B, '못 가는 것')
    expect(sent?.delivered).toBe(true)
    expect(sent?.claimedAt).toBeUndefined()

    // 핵심: 실패한 것은 전달로 굳지 않고, 선점도 남지 않는다.
    expect(failed?.delivered).toBe(false)
    expect(failed?.claimedAt).toBeUndefined()

    // 리스 기한(기본 60초)을 기다리지 않고 곧바로 다시 집힌다 —
    // 별개 프로세스의 훅이 이 순간 볼 수 있다는 뜻이다.
    expect(store.claimTtlMs).toBeGreaterThanOrEqual(60_000)
    const again = await store.claimUndelivered(B)
    expect(again.map(m => m.text)).toEqual(['못 가는 것'])
  }, 20_000)

  test('inject 가 통째로 던져도 선점이 남지 않는다 (finally 경로)', async () => {
    const poison = new PoisonStore({ dir })
    store = poison
    const feed = pushNode()
    await start(feed.node, 40, poison)

    feed.push(A, '독이 든 묶음')
    feed.push(B, '같이 물린 것')

    await until(
      () => errs.some(e => e.includes('주입 묶음을 내보내지 못했다')),
      10_000,
      '주입 실패 보고',
    )

    // 던진 뒤에도 선점이 남지 않는다 — 남으면 기한까지 훅에도 안 보인다.
    await until(async () => (await claimedCount()) === 0, 10_000, '선점 해제')
    expect(await claimedCount()).toBe(0)
    expect((await store.undelivered()).map(m => m.text).sort()).toEqual(
      ['같이 물린 것', '독이 든 묶음'].sort(),
    )
  }, 20_000)

  test('settle 이 실패해도 원래의 주입 예외가 덮이지 않는다', async () => {
    const poison = new PoisonStore({ dir })
    poison.releaseThrows = true
    store = poison
    const feed = pushNode()
    await start(feed.node, 40, poison)

    feed.push(A, '독')

    await until(
      () => errs.some(e => e.includes('주입 묶음을 내보내지 못했다')),
      10_000,
      '주입 실패 보고',
    )
    await until(() => errs.some(e => e.includes('선점을 정리하지 못했다')), 10_000, '정리 실패 보고')

    // 정리 실패가 따로 보고되고, **원래의 주입 예외가 그대로 올라온다**.
    const injectError = errs.find(e => e.includes('주입 묶음을 내보내지 못했다'))
    expect(injectError).toContain('독')
    expect(injectError).not.toContain('정리 실패')

    // 정리가 실패했으므로 선점은 남는다 — 그때는 리스 기한이 뒤를 받친다.
    expect(await claimedCount()).toBe(1)
  }, 20_000)

  test('stop() 이 진행 중 묶음의 정리를 기다린다 — 선점만 찍힌 것이 남지 않는다', async () => {
    const feed = pushNode()
    policy = () => 'block'
    const server = await start(feed.node, 30)

    feed.push(A, '느린 주입')
    await until(async () => (await claimedCount()) === 1, 10_000, '선점')

    // 주입이 끝나기 전에 종료를 부른다. 250ms 뒤에 파이프가 뚫린다.
    setTimeout(() => {
      policy = () => 'pass'
      process.stdout.emit('drain')
    }, 250)

    const t0 = Date.now()
    await server.stop()
    const elapsed = Date.now() - t0

    // 뒷정리를 실제로 기다렸다.
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(STOP_SETTLE_MS)
    expect(await claimedCount()).toBe(0)
    expect((await recordOf(A, '느린 주입'))?.delivered).toBe(true)
  }, 20_000)

  test('파이프가 막혀 주입이 안 끝나도 stop() 은 STOP_SETTLE_MS 안에 돌아온다', async () => {
    const feed = pushNode()
    policy = () => 'block'
    const server = await start(feed.node, 30)

    feed.push(A, '영영 안 끝나는 주입')
    await until(async () => (await claimedCount()) === 1, 10_000, '선점')

    const t0 = Date.now()
    await server.stop()
    const elapsed = Date.now() - t0

    expect(elapsed).toBeGreaterThanOrEqual(STOP_SETTLE_MS * 0.8)
    expect(elapsed).toBeLessThan(STOP_SETTLE_MS + 1_500)
  }, 20_000)

  test('stop() 은 새 묶음을 열지 않는다 — 대기 중인 것은 미전달·미선점으로 남는다', async () => {
    const feed = pushNode()
    const server = await start(feed.node, 30_000)

    feed.push(A, '창이 안 닫힌 것')
    await until(async () => (await recordOf(A, '창이 안 닫힌 것')) !== undefined, 10_000, '저장')

    await server.stop()

    expect(notes).toHaveLength(0)
    const left = await recordOf(A, '창이 안 닫힌 것')
    expect(left?.delivered).toBe(false)
    expect(left?.claimedAt).toBeUndefined()
  }, 20_000)
})
