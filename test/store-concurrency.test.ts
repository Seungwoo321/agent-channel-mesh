/**
 * 저장소 프로세스 간 안전성 테스트 (§6.3 · §6.6)
 *
 * 어댑터(MCP 서버)와 훅은 **별개 프로세스**이고 둘 다 같은 채널 파일을 읽고
 * 고쳐 쓴다. 그래서 이 파일의 핵심 두 테스트는 **진짜 서브프로세스**를 띄운다 —
 * 한 프로세스 안의 `Promise.all` 은 같은 힙과 같은 이벤트 루프를 공유해서,
 * 잠금을 통째로 들어내도 통과할 수 있다. 그런 테스트는 통과하면서 아무것도
 * 증명하지 못한다.
 *
 * 증명하려는 것 둘.
 * 1. **쓰기 유실이 없다** — append 한 건수와 파일에 남은 건수가 정확히 같다.
 * 2. **이중 선점이 없다** — 두 프로세스가 동시에 집어도 같은 id 가 겹치지 않는다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore, type NewMessage, type StoredMessage } from '../src/store/store.js'
import { withLock, lockPathOf } from '../src/store/lock.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-store-conc-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const A = 'aa11'
const B = 'bb22'

function inbound(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    channelId: A,
    direction: 'in',
    axis: 'external',
    senderKeyId: 'deadbeef',
    text: '안녕',
    sentAt: 1_000,
    ...overrides,
  }
}

async function rawMessages(path: string): Promise<StoredMessage[]> {
  return JSON.parse(await readFile(path, 'utf8')).messages
}

const WORKERS = join(import.meta.dir, 'workers')

/** 조건이 참이 될 때까지 기다린다. 출발선을 맞추는 데 쓴다. */
async function until(ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() >= deadline) throw new Error('워커가 제때 준비되지 않았다')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 워커를 진짜 프로세스로 띄운다. 종료 코드·표준 출력을 그대로 돌려준다. */
function spawnWorker(script: string, args: readonly string[]) {
  return Bun.spawn({
    cmd: ['bun', 'run', join(WORKERS, script), ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function finish(proc: ReturnType<typeof spawnWorker>) {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe('프로세스 간 쓰기 유실 (§6.3 — 정본의 데이터 손실)', () => {
  test(
    'append 하는 두 프로세스와 전달 표시하는 프로세스가 겹쳐도 한 건도 사라지지 않는다',
    async () => {
      // 저장소를 먼저 만들어 디렉토리·권한을 확정한다. 워커들은 이 디렉토리를 공유한다.
      const store = new MessageStore({ dir })
      await store.append(inbound({ text: 'seed', sentAt: 0 }))

      const perWriter = 80
      const procs = [
        spawnWorker('store-append.ts', [dir, A, String(perWriter), 'w1']),
        spawnWorker('store-append.ts', [dir, A, String(perWriter), 'w2']),
        // 이 프로세스가 같은 파일을 계속 읽고 되쓴다. 잠금이 없으면 여기서
        // 되쓴 내용이 그 사이 append 된 것을 덮어 메시지가 사라진다.
        spawnWorker('store-churn.ts', [dir, A, '2500']),
      ]
      const results = await Promise.all(procs.map(finish))
      for (const r of results) expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: '' })

      const raw = await rawMessages(store.pathOf(A))
      const texts = raw.map(m => m.text).sort()
      const expected = ['seed']
      for (const tag of ['w1', 'w2']) {
        for (let i = 0; i < perWriter; i++) expected.push(`${tag}-${String(i)}`)
      }
      expected.sort()

      // 개수가 아니라 **집합**으로 본다 — 같은 수만큼 잃고 같은 수만큼 중복돼도
      // 개수 비교는 통과한다.
      expect(texts).toEqual(expected)
      expect(raw).toHaveLength(perWriter * 2 + 1)

      // 전달 표시 프로세스가 실제로 겹쳐 돌았다는 증거. 하나도 없으면 이 테스트는
      // 경합 없는 순차 실행을 검사한 것이고, 그건 아무것도 증명하지 못한다.
      expect(raw.filter(m => m.delivered).length).toBeGreaterThan(0)
    },
    20_000,
  )
})

describe('전달 리스 — 이중 선점 (§6.6)', () => {
  test(
    '두 프로세스가 동시에 집어도 같은 id 를 둘 다 받지 못한다',
    async () => {
      const store = new MessageStore({ dir })
      const total = 150
      for (let i = 0; i < total; i++) await store.append(inbound({ text: `m${String(i)}`, sentAt: i }))

      // 출발선을 맞춘다. 프로세스 기동(수백 ms)이 어긋난 채로 띄우면 먼저 뜬
      // 쪽이 큐를 다 비운 뒤에 두 번째가 시작해, 경합이 없던 실행을 증거로 쓰게 된다.
      const sync = await mkdtemp(join(tmpdir(), 'acm-sync-'))
      const go = join(sync, 'go')
      const ready = (n: string) => join(sync, `ready-${n}`)
      const args = (n: string) => [dir, A, '6000', '1', ready(n), go]

      const procs = [spawnWorker('store-claim.ts', args('1')), spawnWorker('store-claim.ts', args('2'))]
      await until(() => existsSync(ready('1')) && existsSync(ready('2')))
      await writeFile(go, '')

      const [one, two] = await Promise.all(procs.map(finish))
      await rm(sync, { recursive: true, force: true })
      if (one === undefined || two === undefined) throw new Error('워커 결과가 없다')
      expect({ a: one.code, b: two.code }).toEqual({ a: 0, b: 0 })
      expect(one.stderr + two.stderr).toBe('')

      const ids = (t: string) => t.split('\n').filter(l => l.length > 0)
      const first = ids(one.stdout)
      const second = ids(two.stdout)
      const all = [...first, ...second]

      // 1) 겹치지 않는다 — 이게 "같은 말이 두 번 가지 않는다"의 증거다.
      expect(new Set(all).size).toBe(all.length)
      // 2) 빠뜨리지도 않는다 — 배타성을 "아무도 못 집는다"로 얻으면 안 된다.
      expect(new Set(all).size).toBe(total)
      // 3) 둘 다 실제로 집었다. 한쪽이 전부 가져갔으면 경합이 없던 것이다.
      expect(Math.min(first.length, second.length)).toBeGreaterThan(0)
    },
    20_000,
  )

  test('선점한 것은 다시 나오지 않는다 — 기한 전까지는', async () => {
    let clock = 1_000_000
    const store = new MessageStore({ dir, claimTtlMs: 60_000, now: () => clock })
    const saved = await store.append(inbound())

    expect((await store.claimUndelivered(A)).map(m => m.id)).toEqual([saved.id])
    expect(await store.claimUndelivered(A)).toEqual([])

    // 선점은 전달이 아니다. 조회는 그대로 미전달로 보여야 한다 — 그래야 훅이
    // "주입이 실패했다"를 볼 수 있다.
    expect((await store.undelivered(A)).map(m => m.id)).toEqual([saved.id])
  })

  test('기한을 넘긴 선점은 풀린다 — 선점하고 죽은 프로세스가 메시지를 삼키면 안 된다', async () => {
    let clock = 1_000_000
    const store = new MessageStore({ dir, claimTtlMs: 60_000, now: () => clock })
    const saved = await store.append(inbound())

    expect((await store.claimUndelivered(A)).map(m => m.id)).toEqual([saved.id])
    clock += 59_999
    expect(await store.claimUndelivered(A)).toEqual([])

    clock += 2
    expect((await store.claimUndelivered(A)).map(m => m.id)).toEqual([saved.id])
  })

  test('기한 없는 리스는 만들 수 없다', () => {
    expect(() => new MessageStore({ dir, claimTtlMs: 0 })).toThrow(/claimTtlMs/)
    expect(() => new MessageStore({ dir, claimTtlMs: Number.POSITIVE_INFINITY })).toThrow(
      /claimTtlMs/,
    )
  })

  test('release 하면 곧바로 다시 집힌다 — 전달에 실패했을 때의 경로다', async () => {
    const store = new MessageStore({ dir })
    const saved = await store.append(inbound())

    const claimed = await store.claimUndelivered(A)
    expect(claimed.map(m => m.id)).toEqual([saved.id])
    expect(await store.release([saved.id])).toBe(1)

    expect((await store.claimUndelivered(A)).map(m => m.id)).toEqual([saved.id])
    // 두 번 풀어도 개수가 늘지 않는다 — 멱등이다.
    await store.release([saved.id])
    expect(await store.release([saved.id])).toBe(0)
  })

  test('markDelivered 는 선점 표시를 함께 뗀다 — 확정된 뒤의 리스는 죽은 상태다', async () => {
    const store = new MessageStore({ dir })
    const saved = await store.append(inbound())

    await store.claimUndelivered(A)
    expect(await store.markDelivered([saved.id])).toBe(1)

    expect(await store.claimUndelivered(A)).toEqual([])
    expect(await store.undelivered(A)).toEqual([])
    expect((await rawMessages(store.pathOf(A)))[0]).not.toHaveProperty('claimedAt')
  })

  test('선점은 파일에 남는다 — 프로세스가 죽어도 다른 프로세스가 그 사실을 본다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    await store.claimUndelivered(A)

    expect(typeof (await rawMessages(store.pathOf(A)))[0]?.claimedAt).toBe('number')
    // 다른 프로세스를 흉내 낸 새 인스턴스. 같은 것을 다시 집지 않는다.
    expect(await new MessageStore({ dir }).claimUndelivered(A)).toEqual([])
  })

  test('발신은 선점 대상이 아니다 — 주입 대상이 아니라서다', async () => {
    const store = new MessageStore({ dir })
    await store.append({ channelId: A, direction: 'out', axis: 'external', text: '내 말', sentAt: 1 })
    expect(await store.claimUndelivered(A)).toEqual([])
  })

  test('채널을 안 주면 전 채널에서 집고, limit 은 오래된 것부터 준다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound({ channelId: A, text: '먼저', sentAt: 100 }))
    await store.append(inbound({ channelId: B, text: '나중', sentAt: 200 }))

    expect((await store.claimUndelivered(undefined, 1)).map(m => m.text)).toEqual(['먼저'])
    expect((await store.claimUndelivered()).map(m => m.text)).toEqual(['나중'])
  })

  test('limit 을 넘겨 집지 않는다 — 넘겨 집으면 그만큼이 리스에 묶인 채 안 나간다', async () => {
    const store = new MessageStore({ dir })
    for (let i = 0; i < 5; i++) await store.append(inbound({ text: `m${String(i)}`, sentAt: i }))

    expect(await store.claimUndelivered(A, 2)).toHaveLength(2)
    const rest = await rawMessages(store.pathOf(A))
    expect(rest.filter(m => m.claimedAt !== undefined)).toHaveLength(2)
  })

  test('claimedAt 은 호출부가 넣을 수 없다 — 저장소만 찍는다', async () => {
    const store = new MessageStore({ dir })
    await store.append({ ...inbound(), claimedAt: 123 } as NewMessage)
    expect((await rawMessages(store.pathOf(A)))[0]).not.toHaveProperty('claimedAt')
  })

  test('디스크의 claimedAt 이 숫자가 아니면 읽지 않는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    body.messages[0].claimedAt = '방금'
    await writeFile(store.pathOf(A), JSON.stringify(body), { mode: 0o600 })

    await expect(store.read(A)).rejects.toThrow(/messages\[0\]\.claimedAt/)
  })
})

describe('잠금 (src/store/lock.ts)', () => {
  test('살아 있는 잠금은 실제로 막는다 — 막지 못하면 나머지 테스트가 전부 무의미하다', async () => {
    const store = new MessageStore({ dir, lockTimeoutMs: 150 })
    await store.append(inbound())

    const lock = lockPathOf(store.pathOf(A))
    await writeFile(lock, JSON.stringify({ pid: 1, acquiredAt: Date.now(), token: 'x' }), {
      mode: 0o600,
    })

    await expect(store.append(inbound({ text: '막혀야 한다' }))).rejects.toThrow(/잠금을 .*잡지 못했다/)
    expect(await rawMessages(store.pathOf(A))).toHaveLength(1)
  })

  test('오래된 잠금은 회수하고 경고를 남긴다 — 죽은 프로세스가 메시를 영구히 세우면 안 된다', async () => {
    const store = new MessageStore({ dir, lockTimeoutMs: 500 })
    await store.append(inbound())

    const lock = lockPathOf(store.pathOf(A))
    const stale = Date.now() - 60_000
    await writeFile(lock, JSON.stringify({ pid: 999_999, acquiredAt: stale, token: 'dead' }), {
      mode: 0o600,
    })

    await store.append(inbound({ text: '회수 후에도 저장된다', sentAt: 2_000 }))
    expect((await rawMessages(store.pathOf(A))).map(m => m.text)).toEqual([
      '안녕',
      '회수 후에도 저장된다',
    ])
  })

  test('회수는 조용히 하지 않는다 — 홀더가 죽었다는 것은 알아야 할 사실이다', async () => {
    const file = join(dir, 'aa11.json')
    const lock = lockPathOf(file)
    await writeFile(lock, JSON.stringify({ pid: 1, acquiredAt: Date.now() - 60_000, token: 'x' }), {
      mode: 0o600,
    })

    const warnings: string[] = []
    const ran = await withLock(file, async () => 'done', { warn: m => warnings.push(m) })

    expect(ran).toBe('done')
    expect(warnings.join('\n')).toMatch(/오래된 잠금을 회수한다/)
  })

  test('내용이 깨진 잠금도 회수된다 — 반쪽 파일 하나가 채널을 영구히 막으면 안 된다', async () => {
    const file = join(dir, 'aa11.json')
    const lock = lockPathOf(file)
    await writeFile(lock, '{ 반쪽', { mode: 0o600 })
    // 파일 시각을 과거로 돌린다 — 내용으로 판정이 안 되면 시각으로 본다.
    const { utimes } = await import('node:fs/promises')
    const past = new Date(Date.now() - 60_000)
    await utimes(lock, past, past)

    expect(await withLock(file, async () => 'ok', { staleMs: 1_000 })).toBe('ok')
  })

  test('잠금 파일은 0600 이고, 끝나면 사라진다', async () => {
    const file = join(dir, 'aa11.json')
    let observed = 0
    await withLock(file, async () => {
      observed = (await stat(lockPathOf(file))).mode & 0o777
    })

    expect(observed).toBe(0o600)
    await expect(stat(lockPathOf(file))).rejects.toThrow(/ENOENT/)
  })

  test('본체가 던져도 잠금은 놓는다 — 예외 하나로 채널이 서면 안 된다', async () => {
    const file = join(dir, 'aa11.json')
    await expect(
      withLock(file, () => Promise.reject(new Error('실패'))),
    ).rejects.toThrow(/실패/)

    await expect(stat(lockPathOf(file))).rejects.toThrow(/ENOENT/)
  })

  test('잠금 파일은 채널로 잡히지 않는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    await writeFile(lockPathOf(store.pathOf(A)), '{}', { mode: 0o600 })

    expect(await store.channels()).toEqual([A])
  })

  test('purge 도 잠금 안에서 지운다 — 지운 대화가 되살아나면 안 된다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    expect(await store.purge(A)).toBe(true)
    await expect(stat(store.pathOf(A))).rejects.toThrow(/ENOENT/)
    await expect(stat(lockPathOf(store.pathOf(A)))).rejects.toThrow(/ENOENT/)
  })

  test('저장 디렉토리가 없으면 purge 는 그냥 false — 지우려고 디렉토리를 만들지 않는다', async () => {
    const store = new MessageStore({ dir: join(dir, 'nope') })
    expect(await store.purge(A)).toBe(false)
    await expect(stat(join(dir, 'nope'))).rejects.toThrow(/ENOENT/)
  })
})

describe('형식 버전', () => {
  const legacy = (messages: unknown[]) => JSON.stringify({ version: 1, channelId: A, messages })

  test('버전 1 파일을 읽고, 다음 쓰기에서 2 로 올라간다 — 거부하면 기존 대화가 통째로 죽는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound()) // 디렉토리를 만든다
    await writeFile(
      store.pathOf(A),
      legacy([
        {
          id: 'abcd1234',
          channelId: A,
          direction: 'in',
          axis: 'external',
          text: '예전에 쌓인 말',
          sentAt: 1_000,
          storedAt: Date.now(),
          delivered: false,
        },
      ]),
      { mode: 0o600 },
    )

    // 읽힌다. `claimedAt` 이 없을 뿐이므로 "선점되지 않음"으로 읽는다.
    expect((await store.read(A)).map(m => m.text)).toEqual(['예전에 쌓인 말'])
    expect((await store.claimUndelivered(A)).map(m => m.id)).toEqual(['abcd1234'])

    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    expect(body.version).toBe(2)
    expect(body.messages).toHaveLength(1)
  })

  test('모르는 버전은 여전히 거부한다 — 조용한 오해석을 막으려고 둔 필드다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    body.version = 99
    await writeFile(store.pathOf(A), JSON.stringify(body), { mode: 0o600 })

    await expect(store.read(A)).rejects.toThrow(/모르는 저장 형식이다/)
  })
})
