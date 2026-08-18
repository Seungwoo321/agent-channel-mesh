/**
 * 저장소 잠금·전달 리스 — **독립 검증** (§6.3 · §6.6)
 *
 * 이 파일은 구현을 쓴 쪽이 아닌 다른 쪽이 쓴 대조 증거다. 그래서 기존
 * `test/workers/*.ts` 를 재사용하지 않고 **워커를 이 파일이 직접 만들어** 임시
 * 디렉토리에 떨어뜨린다 — 검증이 피검증물과 같은 보조 자산을 공유하면, 그
 * 자산이 틀렸을 때 양쪽이 같이 틀린다.
 *
 * 증명의 전제는 하나다. **같은 프로세스 안의 `Promise.all` 로는 아무것도 증명되지
 * 않는다.** Bun 의 이벤트 루프는 이미 직렬이라, `withLock` 을 통째로 들어내도
 * 한 프로세스 안의 경합 테스트는 그대로 통과한다. 잠금이 지키는 것은 디스크
 * 위의 read-modify-write 이므로, 겨루는 쪽도 **진짜 별개 프로세스**여야 한다.
 *
 * 그래서 출발을 **랑데부 barrier** 로 맞춘다. 워커는 준비되면 ready 파일을 만들고
 * go 파일이 생길 때까지 기다리며, 부모는 전원의 ready 를 본 뒤에 go 를 만든다.
 * 시작 시각을 미리 정해 두는 방식으로는 부족하다 — bun 기동이 그 시각을 넘기면
 * 늦게 온 워커가 이미 빈 큐를 보게 되고, 그러면 경합을 겨루지 않은 채 통과한다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MessageStore, type NewMessage, type StoredMessage } from '../src/store/store.js'
import { lockPathOf } from '../src/store/lock.js'

/** 워커가 import 할 자리. 임시 디렉토리에서 도는 스크립트라 절대 경로여야 한다. */
const STORE_SRC = resolve(import.meta.dir, '..', 'src', 'store', 'store.js')
const LOCK_SRC = resolve(import.meta.dir, '..', 'src', 'store', 'lock.js')

const CH = 'ab12'

/** 임시 루트. 워커 스크립트와 저장 디렉토리를 갈라 둔다. */
let root: string
/** 저장 디렉토리. `MessageStore` 가 0700 으로 만든다. */
let dir: string
/** 워커 스크립트 자리. 저장 디렉토리에 섞으면 채널 목록이 지저분해진다. */
let bin: string
/** barrier 파일 이름이 한 테스트 안에서 겹치지 않게 하는 카운터. */
let round: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'acm-lock-verify-'))
  dir = join(root, 'store')
  bin = join(root, 'bin')
  round = 0
  await mkdir(bin, { recursive: true, mode: 0o700 })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// ─── 워커 ────────────────────────────────────────────────────────────────────

/**
 * 랑데부 barrier 의 워커 쪽. 마지막 두 인자가 ready·go 경로다.
 *
 * 준비됐다고 알린 뒤 go 를 기다린다. 전원이 기동을 마친 것을 부모가 확인하고
 * 나서야 go 가 생기므로, 임계 구역에 들어가는 순간이 실제로 겹친다.
 */
const BARRIER = `
import { writeFile as __w, stat as __s } from 'node:fs/promises'
async function rendezvous(ready, go) {
  await __w(ready, '1')
  for (;;) {
    try { await __s(go); return } catch { await new Promise(r => setTimeout(r, 1)) }
  }
}
`

/** 한 채널에 계속 append 한다. 유실이 나면 파일에 남는 건수가 줄어든다. */
const APPENDER = `
import { MessageStore } from ${JSON.stringify(STORE_SRC)}
${BARRIER}
const [dir, channelId, countRaw, tag, ready, go] = process.argv.slice(2)
const store = new MessageStore({ dir, lockTimeoutMs: 30_000 })
await rendezvous(ready, go)
for (let i = 0; i < Number(countRaw); i++) {
  await store.append({
    channelId,
    direction: 'in',
    axis: 'external',
    senderKeyId: 'deadbeef',
    text: tag + '#' + String(i),
    sentAt: 1_000 + i,
  })
}
`

/**
 * 선점만 하고 놓지 않는다. 집은 id 를 한 줄씩 낸다 — 두 쪽 출력의 교집합이 증거다.
 *
 * 한 배치를 집을 때마다 잠깐 쉰다. **공정성 때문이 아니라 경합을 만들기 위해서다.**
 * `open(path,'wx')` 자문 잠금에는 대기 줄이 없어서, 쉬지 않고 도는 쪽이 놓자마자
 * 다시 잡는다(lock barging) — 백오프 중이던 쪽은 깨어나 보면 큐가 비어 있고,
 * 그러면 한 프로세스만 전부 집은 채로 "겹치지 않았다"가 참이 되어 배타성을
 * 겨루지 않은 테스트가 통과한다. 2ms 를 쉬면 둘이 실제로 번갈아 잡는다.
 */
const CLAIMER = `
import { MessageStore } from ${JSON.stringify(STORE_SRC)}
${BARRIER}
const [dir, channelId, batchRaw, ready, go] = process.argv.slice(2)
const store = new MessageStore({ dir, lockTimeoutMs: 30_000 })
const batch = Number(batchRaw)
await rendezvous(ready, go)
const out = []
for (let empty = 0; empty < 4; ) {
  const claimed = await store.claimUndelivered(channelId, batch)
  if (claimed.length === 0) { empty += 1; await new Promise(r => setTimeout(r, 3)); continue }
  empty = 0
  for (const m of claimed) out.push(m.id)
  await new Promise(r => setTimeout(r, 2))
}
process.stdout.write(out.join('\\n'))
`

/**
 * 잠금을 잡고 버틴다. 잡은 순간 marker 파일을 만들어 부모가 그 사실을 알게 한다 —
 * "살아 있는 잠금"을 겨루려면 정말 들고 있는 동안 겨뤄야 한다.
 */
const HOLDER = `
import { withLock } from ${JSON.stringify(LOCK_SRC)}
import { writeFile } from 'node:fs/promises'
const [file, holdMs, marker] = process.argv.slice(2)
await withLock(file, async () => {
  await writeFile(marker, String(process.pid))
  await new Promise(r => setTimeout(r, Number(holdMs)))
})
`

/** 저장소로 append 한다. stderr 를 그대로 흘려, 회수 경고가 실제로 나가는지 본다. */
const APPEND_ONCE = `
import { MessageStore } from ${JSON.stringify(STORE_SRC)}
const [dir, channelId, text, staleMs, timeoutMs] = process.argv.slice(2)
const store = new MessageStore({
  dir,
  lockStaleMs: Number(staleMs),
  lockTimeoutMs: Number(timeoutMs),
})
await store.append({
  channelId,
  direction: 'in',
  axis: 'external',
  text,
  sentAt: 9_000,
})
`

// ─── 도구 ────────────────────────────────────────────────────────────────────

async function worker(name: string, source: string): Promise<string> {
  const path = join(bin, `${name}.ts`)
  await writeFile(path, source, { mode: 0o700 })
  return path
}

function spawn(script: string, args: readonly string[]) {
  return Bun.spawn({ cmd: ['bun', 'run', script, ...args], stdout: 'pipe', stderr: 'pipe' })
}

interface Finished {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function finish(proc: ReturnType<typeof spawn>): Promise<Finished> {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** 자식이 깨끗이 끝났는지. 실패 원문을 통째로 보여야 원인을 찾을 수 있다. */
function expectClean(r: Finished): void {
  expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' })
}

/** 결과 배열에서 i 번째. 없으면 그 자체가 실패다 — 조용히 undefined 로 넘기지 않는다. */
function at(results: readonly Finished[], i: number): Finished {
  const r = results[i]
  if (r === undefined) throw new Error(`자식 ${String(i)} 의 결과가 없다`)
  return r
}

/** 파일이 생길 때까지 기다린다. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await stat(path)
      return true
    } catch {
      if (Date.now() >= deadline) return false
      await Bun.sleep(5)
    }
  }
}

/**
 * 워커 여러 개를 띄우고 **전원이 준비된 뒤에** 동시에 출발시킨다.
 *
 * 시작 시각을 미리 못 박는 방식은 기동이 그 시각을 넘기면 무너진다 — 늦게 온
 * 쪽이 이미 끝난 큐를 보고 아무것도 못 집으면, 배타성을 겨루지 않은 테스트가
 * 조용히 통과한다. barrier 는 그 실패 양식을 없앤다.
 */
async function rendezvous(
  script: string,
  argsList: readonly (readonly string[])[],
): Promise<Finished[]> {
  const tag = String(round++)
  const go = join(root, `go-${tag}`)
  const readies = argsList.map((_, i) => join(root, `ready-${tag}-${String(i)}`))
  const procs = argsList.map((args, i) => spawn(script, [...args, readies[i] ?? '', go]))

  for (const ready of readies) {
    expect(await waitForFile(ready, 20_000)).toBe(true)
  }
  await writeFile(go, '1')

  return Promise.all(procs.map(finish))
}

/** 파일에 실제로 남은 것. 저장소를 거치지 않고 본다 — 정본은 디스크다. */
async function rawMessages(path: string): Promise<StoredMessage[]> {
  const parsed: { messages: StoredMessage[] } = JSON.parse(await readFile(path, 'utf8'))
  return parsed.messages
}

function inbound(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    channelId: CH,
    direction: 'in',
    axis: 'external',
    senderKeyId: 'deadbeef',
    text: '기본',
    sentAt: 1_000,
    ...overrides,
  }
}

const lines = (t: string): string[] => t.split('\n').filter(l => l.length > 0)

// ─── 1. 쓰기 유실 ────────────────────────────────────────────────────────────

describe('프로세스 간 append — lost update (§6.3)', () => {
  test(
    '자식 5개가 각각 25건씩 동시에 append 해도 125건이 그대로 남는다',
    async () => {
      // 디렉토리·권한을 먼저 확정한다. 자식들은 이 상태를 공유해 출발한다.
      const store = new MessageStore({ dir })
      await store.append(inbound({ text: 'seed', sentAt: 0 }))

      const script = await worker('appender', APPENDER)
      const workers = 5
      const each = 25
      const results = await rendezvous(
        script,
        Array.from({ length: workers }, (_, i) => [dir, CH, String(each), `w${String(i)}`]),
      )
      for (const r of results) expectClean(r)

      const raw = await rawMessages(store.pathOf(CH))

      // 개수만 보면 "같은 수만큼 잃고 같은 수만큼 중복된" 경우를 통과시킨다.
      // 집합으로 대조해야 유실도 중복도 함께 잡힌다.
      const expected = ['seed']
      for (let w = 0; w < workers; w++) {
        for (let i = 0; i < each; i++) expected.push(`w${String(w)}#${String(i)}`)
      }
      expect(raw.map(m => m.text).sort()).toEqual(expected.sort())
      expect(raw).toHaveLength(workers * each + 1)
      // id 도 전부 다르다 — 같은 레코드가 두 번 쓰인 경우를 따로 막는다.
      expect(new Set(raw.map(m => m.id)).size).toBe(raw.length)
    },
    90_000,
  )
})

// ─── 2. 이중 선점 ────────────────────────────────────────────────────────────

describe('프로세스 간 claimUndelivered — 배타성 (§6.6)', () => {
  test(
    '자식 둘이 동시에 집어도 교집합은 0 이고 합집합은 전부다',
    async () => {
      const store = new MessageStore({ dir })
      const total = 80
      for (let i = 0; i < total; i++) {
        await store.append(inbound({ text: `m${String(i)}`, sentAt: i }))
      }
      const all = new Set((await store.undelivered(CH)).map(m => m.id))
      expect(all.size).toBe(total)

      const script = await worker('claimer', CLAIMER)
      const results = await rendezvous(script, [
        [dir, CH, '2'],
        [dir, CH, '2'],
      ])
      const one = at(results, 0)
      const two = at(results, 1)
      expectClean(one)
      expectClean(two)

      const first = lines(one.stdout)
      const second = lines(two.stdout)
      const union = [...first, ...second]

      // 교집합 0. 같은 말이 두 세션에 두 번 가지 않는다는 증거다.
      const overlap = first.filter(id => second.includes(id))
      expect(overlap).toEqual([])
      // 합집합 = 전부. 배타성을 "아무도 못 집는다"로 얻으면 안 된다.
      expect(new Set(union).size).toBe(union.length)
      expect(new Set(union)).toEqual(all)
      // 둘 다 실제로 집었다. 한쪽이 다 가져갔으면 경합이 없던 것이고,
      // 그러면 이 테스트는 배타성을 겨루지 않은 채 통과한 것이다.
      expect(Math.min(first.length, second.length)).toBeGreaterThan(0)
    },
    90_000,
  )

  test(
    '선점 중인 것은 리스 기한 안에는 다시 안 나온다 — 다른 프로세스에도',
    async () => {
      const store = new MessageStore({ dir })
      const saved = await store.append(inbound())
      expect((await store.claimUndelivered(CH)).map(m => m.id)).toEqual([saved.id])

      // 같은 인스턴스에서 한 번, 별개 프로세스에서 한 번. 리스가 메모리가 아니라
      // 파일에 있다는 것을 프로세스 경계 너머에서 확인한다.
      expect(await store.claimUndelivered(CH)).toEqual([])
      const script = await worker('claimer', CLAIMER)
      const child = at(await rendezvous(script, [[dir, CH, '5']]), 0)
      expectClean(child)
      expect(lines(child.stdout)).toEqual([])

      // 선점은 전달이 아니다. 조회에는 그대로 미전달로 보여야 훅이 안전망이 된다.
      expect((await store.undelivered(CH)).map(m => m.id)).toEqual([saved.id])
    },
    30_000,
  )

  test(
    '기한 지난 선점은 풀린다 — 선점하고 죽은 프로세스가 메시지를 삼키면 안 된다',
    async () => {
      let clock = 5_000_000
      const store = new MessageStore({ dir, claimTtlMs: 250, now: () => clock })
      const saved = await store.append(inbound())

      expect((await store.claimUndelivered(CH)).map(m => m.id)).toEqual([saved.id])
      clock += 249
      expect(await store.claimUndelivered(CH)).toEqual([])

      clock += 2 // 기한 초과
      expect((await store.claimUndelivered(CH)).map(m => m.id)).toEqual([saved.id])

      // 시계를 주입하지 않은 별개 프로세스도 같은 판정을 해야 한다. 기본 리스가
      // 60초이므로 그보다 확실히 오래된 선점을 파일에 박아 둔다 — 실제 시각만
      // 보고도 "죽은 선점"으로 읽혀야 한다.
      const body: { messages: StoredMessage[] } = JSON.parse(await readFile(store.pathOf(CH), 'utf8'))
      await writeFile(
        store.pathOf(CH),
        JSON.stringify({
          version: 2,
          channelId: CH,
          messages: body.messages.map(m => ({
            ...m,
            storedAt: Date.now(),
            claimedAt: Date.now() - 10 * 60_000,
          })),
        }),
        { mode: 0o600 },
      )

      const script = await worker('claimer', CLAIMER)
      const child = at(await rendezvous(script, [[dir, CH, '5']]), 0)
      expectClean(child)
      expect(lines(child.stdout)).toEqual([saved.id])
    },
    30_000,
  )

  test('release 하면 곧바로 다시 집힌다 — 전달 실패의 복귀 경로다', async () => {
    const store = new MessageStore({ dir })
    const saved = await store.append(inbound())

    expect((await store.claimUndelivered(CH)).map(m => m.id)).toEqual([saved.id])
    expect(await store.release([saved.id])).toBe(1)
    expect((await rawMessages(store.pathOf(CH)))[0]).not.toHaveProperty('claimedAt')
    expect((await store.claimUndelivered(CH)).map(m => m.id)).toEqual([saved.id])

    // 멱등이다. 이미 풀린 것을 또 풀어도 개수가 늘지 않는다.
    await store.release([saved.id])
    expect(await store.release([saved.id])).toBe(0)
  })

  test(
    'markDelivered 뒤에는 어느 프로세스에서도 안 나온다',
    async () => {
      const store = new MessageStore({ dir })
      const saved = await store.append(inbound())
      await store.claimUndelivered(CH)
      expect(await store.markDelivered([saved.id])).toBe(1)

      expect(await store.claimUndelivered(CH)).toEqual([])
      expect(await store.undelivered(CH)).toEqual([])
      // 전달이 확정된 뒤의 리스는 죽은 상태다. 파일에 남기지 않는다.
      expect((await rawMessages(store.pathOf(CH)))[0]).not.toHaveProperty('claimedAt')

      const script = await worker('claimer', CLAIMER)
      const child = at(await rendezvous(script, [[dir, CH, '5']]), 0)
      expectClean(child)
      expect(lines(child.stdout)).toEqual([])
    },
    30_000,
  )
})

// ─── 3. 잠금 자체 ────────────────────────────────────────────────────────────

describe('잠금 파일 (src/store/lock.ts)', () => {
  test(
    '살아 있는 잠금은 못 뺏는다 — 못 막으면 위의 증명이 전부 무의미하다',
    async () => {
      const store = new MessageStore({ dir, lockTimeoutMs: 200 })
      await store.append(inbound())

      // 손으로 만든 잠금 파일이 아니라 **진짜 홀더**와 겨룬다. 자문 잠금이 파일의
      // 존재만으로 동작하는지, 실제 임계 구역을 든 프로세스를 상대로도 그런지는
      // 같은 말이 아니다.
      const script = await worker('holder', HOLDER)
      const marker = join(root, 'held')
      const proc = spawn(script, [store.pathOf(CH), '2500', marker])
      expect(await waitForFile(marker, 20_000)).toBe(true)

      // staleMs 기본 10초라 이 잠금은 아직 stale 이 아니다. 200ms 안에 못 잡고 던진다.
      await expect(store.append(inbound({ text: '막혀야 한다' }))).rejects.toThrow(
        /잠금을 200ms 안에 잡지 못했다/,
      )
      // 던졌으면 쓰지도 않았어야 한다. 던지고도 썼으면 그게 곧 lost update 다.
      expect(await rawMessages(store.pathOf(CH))).toHaveLength(1)

      expectClean(await finish(proc))
      // 홀더가 끝났으니 이제는 통과한다 — 영구히 막힌 것이 아니라는 확인이다.
      await store.append(inbound({ text: '이제는 된다', sentAt: 2_000 }))
      expect(await rawMessages(store.pathOf(CH))).toHaveLength(2)
    },
    40_000,
  )

  test(
    '잠금 파일은 들고 있는 동안 0600 이고, 정상 종료 뒤 사라진다',
    async () => {
      const store = new MessageStore({ dir })
      await store.append(inbound())
      const lock = lockPathOf(store.pathOf(CH))

      const script = await worker('holder', HOLDER)
      const marker = join(root, 'held-mode')
      const proc = spawn(script, [store.pathOf(CH), '600', marker])
      expect(await waitForFile(marker, 20_000)).toBe(true)

      expect((await stat(lock)).mode & 0o777).toBe(0o600)
      // 홀더의 pid 가 적혀 있다 — 잠금이 진단 정보를 들고 있다는 확인이다.
      const holder: { pid: number; acquiredAt: number; token: string } = JSON.parse(
        await readFile(lock, 'utf8'),
      )
      expect(holder.pid).toBe(proc.pid)
      expect(typeof holder.token).toBe('string')

      expectClean(await finish(proc))
      // 자식이 정상 종료했으므로 잠금은 남아 있으면 안 된다. 남으면 다음 프로세스가
      // stale 기한(10초)만큼 서게 되고, 그게 곧 메시가 멈추는 자리다.
      await expect(stat(lock)).rejects.toThrow(/ENOENT/)
    },
    40_000,
  )

  test(
    '죽은 잠금은 회수하고, 회수했다는 사실을 stderr 로 알린다',
    async () => {
      const store = new MessageStore({ dir })
      await store.append(inbound())
      const lock = lockPathOf(store.pathOf(CH))

      // 홀더가 죽어 남은 잠금을 흉내 낸다. 자문 잠금은 커널이 치워 주지 않으므로
      // 회수가 없으면 이 채널의 메시는 영구히 선다.
      await writeFile(
        lock,
        JSON.stringify({ pid: 999_999, acquiredAt: Date.now() - 60_000, token: 'dead' }),
        { mode: 0o600 },
      )

      // 회수를 **저장소 경로로** 확인한다 — `withLock` 을 직접 부르면 store 가
      // 잠금 옵션(`lockStaleMs`)을 제대로 넘기는지는 검사되지 않는다.
      const script = await worker('append-once', APPEND_ONCE)
      const child = await finish(spawn(script, [dir, CH, '회수 후 저장', '1000', '3000']))
      expect(child.code).toBe(0)

      // 조용히 뺏지 않는다. 홀더가 죽었다는 것은 알아야 할 사실이다.
      expect(child.stderr).toMatch(/오래된 잠금을 회수한다/)
      expect(child.stderr).toContain(lock)

      expect((await rawMessages(store.pathOf(CH))).map(m => m.text)).toEqual([
        '기본',
        '회수 후 저장',
      ])
      // 회수한 쪽이 자기 잠금을 놓고 끝났다.
      await expect(stat(lock)).rejects.toThrow(/ENOENT/)
    },
    40_000,
  )

  test(
    'stale 기준을 안 넘긴 잠금은 회수 대상이 아니다 — 회수가 경합을 만들면 안 된다',
    async () => {
      const store = new MessageStore({ dir })
      await store.append(inbound())
      const lock = lockPathOf(store.pathOf(CH))
      await writeFile(lock, JSON.stringify({ pid: 1, acquiredAt: Date.now(), token: 'alive' }), {
        mode: 0o600,
      })

      // staleMs 10초 > 잠금 나이 0. 회수하지 않고 timeout 으로 던져야 한다.
      const script = await worker('append-once', APPEND_ONCE)
      const child = await finish(spawn(script, [dir, CH, '막혀야 한다', '10000', '200']))
      expect(child.code).not.toBe(0)
      expect(child.stderr).toMatch(/잠금을 200ms 안에 잡지 못했다/)
      expect(child.stderr).not.toMatch(/오래된 잠금을 회수한다/)
      expect(await rawMessages(store.pathOf(CH))).toHaveLength(1)
    },
    40_000,
  )
})

// ─── 4. 형식 호환 ────────────────────────────────────────────────────────────

describe('형식 버전 1 (claimedAt 이 없던 파일)', () => {
  test(
    'v1 파일이 읽히고, 그 메시지가 선점 가능하다 — 거부하면 기존 대화가 죽는다',
    async () => {
      const store = new MessageStore({ dir })
      await store.append(inbound()) // 디렉토리를 0700 으로 만든다
      const legacyId = 'c0ffee01'

      // `claimedAt` 도 `version: 2` 도 없는, 업그레이드 전 사용자의 파일이다.
      await writeFile(
        store.pathOf(CH),
        JSON.stringify({
          version: 1,
          channelId: CH,
          messages: [
            {
              id: legacyId,
              channelId: CH,
              direction: 'in',
              axis: 'external',
              text: '예전에 쌓인 말',
              sentAt: 1_000,
              storedAt: Date.now(),
              delivered: false,
            },
          ],
        }),
        { mode: 0o600 },
      )

      expect((await store.read(CH)).map(m => m.text)).toEqual(['예전에 쌓인 말'])
      // `claimedAt` 없음 = 선점되지 않음. 이게 맞는 해석이다.
      expect((await store.undelivered(CH)).map(m => m.id)).toEqual([legacyId])
      expect((await store.claimUndelivered(CH)).map(m => m.id)).toEqual([legacyId])

      // 다음 쓰기에서 2 로 올라가고, 내용은 그대로다.
      const body: { version: number; messages: StoredMessage[] } = JSON.parse(
        await readFile(store.pathOf(CH), 'utf8'),
      )
      expect(body.version).toBe(2)
      expect(body.messages).toHaveLength(1)
      expect(typeof body.messages[0]?.claimedAt).toBe('number')

      // 별개 프로세스도 같은 파일을 읽는다 — 승격이 이 인스턴스의 메모리에만
      // 있던 것이 아니라는 확인이다.
      const script = await worker('claimer', CLAIMER)
      const child = at(await rendezvous(script, [[dir, CH, '5']]), 0)
      expectClean(child)
      expect(lines(child.stdout)).toEqual([]) // 이미 선점됐으므로 안 나온다
    },
    30_000,
  )
})
