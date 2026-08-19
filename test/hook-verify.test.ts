/**
 * 훅 독립 검증 — 구현자가 아닌 쪽이 공격한다
 *
 * 검증 대상은 `src/install/notify.ts`(훅 런타임)와 `src/install/hooks.ts`
 * (설치기)다. 기존 `test/hook-notify.test.ts` · `test/hook-install.test.ts` 는
 * 구현자가 썼으므로 여기서는 근거로 쓰지 않는다 — 같은 오해를 공유한다.
 *
 * 공격 축은 여덟이다: 중복 전달 · 유실 · 절단 · "더 있다" 건수 ·
 * 남의 설정 파괴 · 멱등성 · 권한/원자성 · 훅이 세션을 세우는가.
 *
 * **실제 홈을 건드리지 않는다.** 모든 경로는 `mkdtemp` 로 판 임시 홈이고,
 * 훅 서브프로세스에는 `ACM_CONFIG` 로 임시 설정을 주며 그 설정의 `store.dir`
 * 도 임시다 — 하나라도 빠지면 `~/.agent-channel-mesh` 를 친다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, readdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore, type NewMessage, type StoredMessage } from '../src/store/store.js'
import { renderBundle } from '../src/adapter/bundle.js'
import { collect, runHook, HOOK_CONTEXT_LIMIT, HOOK_BATCH_LIMIT } from '../src/install/notify.js'
import { install, mergeHooks, HOOK_MARKER } from '../src/install/hooks.js'
import { deriveIdentity } from '../src/identity/keys.js'
import { toKey } from '../src/identity/fingerprint.js'
import { fromHex } from '../src/adapter/config.js'

const REPO = join(import.meta.dir, '..')
const NOTIFY = join(REPO, 'src', 'install', 'notify.ts')

/** Codex 설치기가 잡아 주는 컨텍스트 상한. `hooks.ts` 의 비공개 상수와 같은 값이다. */
const CODEX_CONTEXT_LIMIT = 12_000

const A = 'aa11'
const B = 'bb22'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function until(p: () => boolean, timeoutMs = 15_000, what = '조건'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (p()) return
    if (Date.now() > deadline) throw new Error(`${what} 이(가) 서지 않았다`)
    await sleep(5)
  }
}

let dir: string
let store: MessageStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-verify-'))
  store = new MessageStore({ dir: join(dir, 'messages') })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function inbound(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    channelId: A,
    direction: 'in',
    axis: 'external',
    senderLabel: 'bob',
    text: '안녕',
    sentAt: 1_000,
    ...overrides,
  }
}

/* ================================================================== *
 * 1. 중복 전달 — 별개 프로세스 두 개가 같은 저장소를 동시에 드레인
 * ================================================================== */

/**
 * 워커 소스.
 *
 * `hook` 은 검증 대상인 `collect()` 를 그대로 부른다. `adapter` 는
 * `src/adapter/server.ts:179·206` 의 드레인 골격(선점 → 표시)을 그대로 옮긴
 * 것이고, `naive` 는 그 한 줄만 조회(`undelivered`)로 바꾼 **음성 대조군**이다 —
 * 대조군에서 중복이 안 나오면 이 하네스는 아무것도 검증하지 못한 것이다.
 *
 * 합류 창: 자식이 `ready` 를 쓰고 `go` 가 생길 때까지 바쁘게 돈다. 늦게 출발한
 * 쪽이 빈 큐를 보면 "교집합 0" 이 공허하게 통과하므로 `min(A,B) > 0` 을 함께
 * 단언할 수 있어야 한다.
 */
function workerSource(): string {
  return [
    "import { writeFileSync, existsSync } from 'node:fs'",
    `import { MessageStore } from '${REPO}/src/store/store.js'`,
    `import { collect } from '${REPO}/src/install/notify.js'`,
    `import { renderBundle } from '${REPO}/src/adapter/bundle.js'`,
    '',
    'const [mode, storeDir, ready, go, out] = process.argv.slice(2)',
    'const store = new MessageStore({ dir: storeDir })',
    'writeFileSync(ready, "1")',
    'while (!existsSync(go)) {}',
    '',
    'let texts = []',
    'if (mode === "hook") {',
    '  const text = await collect(store)',
    '  texts = text.match(/M\\d+/g) ?? []',
    '} else if (mode === "adapter") {',
    '  const batch = await store.claimUndelivered(undefined, 20)',
    '  renderBundle(batch, { markNew: true })',
    '  await store.markDelivered(batch.map(m => m.id))',
    '  texts = batch.map(m => m.text)',
    '} else {',
    '  const batch = await store.undelivered(undefined, 20)',
    '  renderBundle(batch, { markNew: true })',
    '  await store.markDelivered(batch.map(m => m.id))',
    '  texts = batch.map(m => m.text)',
    '}',
    'writeFileSync(out, JSON.stringify(texts))',
  ].join('\n')
}

/** 두 워커를 합류 창으로 동시에 출발시키고 각자 집은 텍스트를 돌려준다. */
async function race(
  modes: [string, string],
  seedCount: number,
  attempt = 0,
): Promise<[string[], string[]]> {
  const storeDir = join(dir, `messages-${modes.join('-')}-${String(attempt)}`)
  const s = new MessageStore({ dir: storeDir })
  for (let i = 0; i < seedCount; i++) {
    await s.append(
      inbound({ channelId: i % 2 === 0 ? A : B, text: `M${String(i)}`, sentAt: 1_000 + i }),
    )
  }

  const script = join(dir, 'worker.ts')
  await writeFile(script, workerSource())
  const go = join(dir, `go-${modes.join('-')}-${String(attempt)}`)

  const procs = modes.map((mode, n) => {
    const ready = join(dir, `ready-${String(attempt)}-${String(n)}`)
    const out = join(dir, `out-${String(attempt)}-${String(n)}`)
    const proc = Bun.spawn(['bun', 'run', script, mode, storeDir, ready, go, out], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { proc, ready, out }
  })

  await until(
    () => procs.every(p => existsSync(p.ready)),
    20_000,
    '두 워커가 출발선에 서는 것',
  )
  await writeFile(go, '1')

  const results: string[][] = []
  for (const p of procs) {
    const code = await p.proc.exited
    const err = await new Response(p.proc.stderr).text()
    if (code !== 0) throw new Error(`워커가 ${String(code)} 로 죽었다: ${err}`)
    results.push(JSON.parse(await readFile(p.out, 'utf8')) as string[])
  }
  return [results[0]!, results[1]!]
}

describe('1. 중복 전달 — 별개 프로세스', () => {
  /**
   * 합류 창은 프로세스 스케줄링을 완전히 통제하지 못한다 — 한쪽이 큐를 다
   * 가져가면 `min(A,B) > 0` 이 우연히 0 이 된다. 그래서 **매 시도마다** 배타와
   * 무손실(합집합 = 전체)을 단언하고, "둘 다 실제로 집은" 시도가 최소 한 번은
   * 있었는지를 마지막에 확인한다. 그 확인이 없으면 배타 단언은 공허하다.
   */
  async function repeatRace(modes: [string, string], attempts = 5): Promise<boolean> {
    let bothWorked = false
    for (let k = 0; k < attempts; k++) {
      const [a, b] = await race(modes, 40, k)
      expect(a.filter(t => b.includes(t))).toEqual([])
      expect(new Set([...a, ...b]).size).toBe(40)
      if (Math.min(a.length, b.length) > 0) bothWorked = true
    }
    return bothWorked
  }

  test('훅 두 개가 동시에 드레인해도 같은 메시지를 두 번 싣지 않는다', async () => {
    expect(await repeatRace(['hook', 'hook'])).toBe(true)
  }, 120_000)

  test('훅과 어댑터가 동시에 드레인해도 겹치지 않는다', async () => {
    expect(await repeatRace(['hook', 'adapter'])).toBe(true)
  }, 120_000)

  test('음성 대조군 — 선점을 빼면 이 하네스는 중복을 잡아낸다', async () => {
    // 딱 한 줄(선점 → 조회)만 다르다. 여기서 중복이 한 번도 안 나오면 위 두
    // 테스트는 아무것도 증명하지 못한 것이므로, 그 사실을 실패로 드러낸다.
    let sawDuplicate = false
    for (let k = 0; k < 5; k++) {
      const [a, b] = await race(['naive', 'naive'], 40, k)
      if (a.some(t => b.includes(t))) sawDuplicate = true
    }
    expect(sawDuplicate).toBe(true)
  }, 120_000)
})

/* ================================================================== *
 * 2. 유실 — 훅이 어디서 죽으면 메시지가 영영 안 보이는가
 * ================================================================== */

describe('2. 유실', () => {
  test('모르는 이벤트로 불려도 메시지를 삼키지 않는다', async () => {
    await store.append(inbound({ text: '중요한 말' }))

    // Codex 의 SessionEnd, Claude 의 Notification 처럼 KNOWN_EVENTS
    // 밖의 이름으로 훅이 불리는 경우다. 설치기가 등록하지 않아도, 사용자가
    // 손으로 다른 이벤트에 걸거나 에이전트가 이름을 바꾸면 그대로 재현된다.
    const out = await runHook('SessionEnd', store)
    expect(out.hookSpecificOutput).toBeUndefined()

    // 출력은 버려졌다. 그러면 저장소에는 아직 미전달로 남아 있어야 한다 —
    // 안 그러면 그 메시지는 어디에도 도달하지 못한 채 사라진다.
    const left = await store.undelivered()
    expect(left.map(m => m.text)).toEqual(['중요한 말'])
  })

  test('--event 없이 불려도 메시지를 삼키지 않는다', async () => {
    await store.append(inbound({ text: '삼키면 안 되는 말' }))
    const out = await runHook('', store)
    expect(out.hookSpecificOutput).toBeUndefined()
    expect((await store.undelivered()).length).toBe(1)
  })

  test('표시가 중간에서 죽어도 본문은 나간다', async () => {
    class PartialMark extends MessageStore {
      override async markDelivered(ids: readonly string[]): Promise<number> {
        const first = ids[0]
        // rewriteByIds 는 채널을 하나씩 잠그고 돈다 — 중간에서 죽으면
        // 앞 채널만 delivered 로 찍힌 채 남는다. 그 상태를 재현한다.
        if (first !== undefined) await super.markDelivered([first])
        throw new Error('표시 도중 죽었다')
      }
    }
    const s = new PartialMark({ dir: join(dir, 'partial') })
    await s.append(inbound({ text: '첫 번째' }))
    await s.append(inbound({ text: '두 번째', sentAt: 1_001 }))

    // 여기서 던지면 이미 만들어진 본문이 사라지고, 그때 앞 채널은 이미
    // delivered 로 찍혀 있어 **다음 훅에도 안 나온다** — 그것이 유실이다.
    // 그래서 표시 실패는 본문을 막지 않는다.
    const text = await collect(s)
    expect(text).toContain('첫 번째')
    expect(text).toContain('두 번째')

    // 대가는 유실이 아니라 중복이다 — 못 찍은 쪽만 다음에 한 번 더 뜬다.
    const left = await s.undelivered()
    expect(left.map(m => m.text)).toEqual(['두 번째'])
  })

  test('release 가 실패해도 영구 유실은 아니다 — 리스 기한 뒤 다시 잡힌다', async () => {
    class NoRelease extends MessageStore {
      override async release(): Promise<number> {
        throw new Error('풀지 못했다')
      }
    }
    const s = new NoRelease({ dir: join(dir, 'norelease'), claimTtlMs: 50 })
    await s.append(inbound({ text: '한 건' }))
    class Boom extends NoRelease {
      override async undelivered(): Promise<readonly StoredMessage[]> {
        throw new Error('조회가 죽었다')
      }
    }
    const b = new Boom({ dir: join(dir, 'norelease'), claimTtlMs: 50 })
    await expect(collect(b)).rejects.toThrow()

    // 선점은 남지만 기한이 지나면 풀린다 — 영구 유실이 아니다.
    await sleep(80)
    const again = await s.claimUndelivered()
    expect(again.map(m => m.text)).toEqual(['한 건'])
  })
})

/* ================================================================== *
 * 3. 절단 — 예산 계산이 실제 출력과 맞는가
 * ================================================================== */

describe('3. 절단', () => {
  test('출력 전체가 글자 예산 안에 들어간다 (안내문 포함)', async () => {
    // 본문 4건이 예산에 딱 맞고, 안내문이 그 위에 얹히는 크기다.
    for (let i = 0; i < 6; i++) {
      await store.append(inbound({ text: 'z'.repeat(1904), sentAt: 1_000 + i }))
    }
    const text = await collect(store)
    expect(text).toContain('건이 더 있다')
    // fit() 은 본문만 재고 안내문은 안 잰다 — 모델에게 실제로 가는 것은 합이다.
    expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_LIMIT)
  })

  test('한 건이 커도 에이전트 쪽 상한을 넘기지 않는다', async () => {
    // notify.ts:45-46 · hooks.ts:40-46 은 "설치기가 넉넉히 잡아 두므로 정상
    // 경로에서 에이전트 쪽 절단은 일어나지 않는다"고 약속한다. 한 건이 상한보다
    // 크면 그 약속이 깨지고, 잘리는 자리는 말 중간이다.
    await store.append(inbound({ text: 'y'.repeat(50_000) }))
    const text = await collect(store)
    expect(text.length).toBeLessThanOrEqual(CODEX_CONTEXT_LIMIT)
  })

  test('여러 채널이 섞여도 앞에서부터 자르는 방식이 성립한다', async () => {
    // renderBundle 은 채널별로 묶지만 그룹 머리를 붙이지 않는다. 그래서
    // 접두집합의 길이는 단조 증가하고, fit() 의 내림차순 탐색이 옳다.
    const channels = ['aa11', 'bb22', 'cc33']
    for (let i = 0; i < 12; i++) {
      await store.append(
        inbound({
          channelId: channels[i % 3]!,
          text: `본문 ${String(i)} ${'q'.repeat(50 * (i + 1))}`,
          sentAt: 1_000 + i,
        }),
      )
    }
    const all = await store.undelivered()
    let prev = 0
    for (let n = 1; n <= all.length; n++) {
      const len = renderBundle(all.slice(0, n), { markNew: true }).length
      expect(len).toBeGreaterThanOrEqual(prev)
      prev = len
    }
  })
})

/* ================================================================== *
 * 4. "더 있다" 건수
 * ================================================================== */

describe('4. 남은 건수', () => {
  test('세는 도중 새 메시지가 들어와도 음수가 되지 않는다', async () => {
    class AppendMidway extends MessageStore {
      override async undelivered(
        channelId?: string,
        limit?: number,
      ): Promise<readonly StoredMessage[]> {
        // 다른 프로세스가 세는 사이에 append 한 상황.
        if (!this.appended) {
          this.appended = true
          await this.append(inbound({ channelId: B, text: '늦게 온 것', sentAt: 9_999 }))
        }
        return super.undelivered(channelId, limit)
      }
      private appended = false
    }
    const s = new AppendMidway({ dir: join(dir, 'race') })
    for (let i = 0; i < 3; i++) await s.append(inbound({ text: `초기 ${String(i)}`, sentAt: 1_000 + i }))

    const text = await collect(s)
    expect(text).toContain('1건이 더 있다')
  })

  test('선점 중 만료로 줄어들어도 음수가 새어 나오지 않는다', async () => {
    // 보관 기한이 짧으면 세는 사이에 keep 이 통째로 떨어질 수 있다.
    class Shrink extends MessageStore {
      override async undelivered(): Promise<readonly StoredMessage[]> {
        return []
      }
    }
    const s = new Shrink({ dir: join(dir, 'shrink') })
    for (let i = 0; i < 3; i++) await s.append(inbound({ text: `X${String(i)}`, sentAt: 1_000 + i }))
    const text = await collect(s)
    expect(text).not.toMatch(/-\d+건이 더 있다/)
    expect(text).not.toContain('건이 더 있다')
  })

  test('건수 상한을 넘기면 남은 수를 정확히 알린다', async () => {
    const total = HOOK_BATCH_LIMIT + 7
    for (let i = 0; i < total; i++) {
      await store.append(inbound({ text: `n${String(i)}`, sentAt: 1_000 + i }))
    }
    const text = await collect(store)
    expect(text).toContain(`${String(total - HOOK_BATCH_LIMIT)}건이 더 있다`)
  })
})

/* ================================================================== *
 * 5. 설치기가 남의 설정을 부수는가
 * ================================================================== */

let home: string
const claudePath = () => join(home, '.claude', 'settings.json')
const codexPath = () => join(home, '.codex', 'hooks.json')

async function seedClaude(doc: unknown): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(claudePath(), JSON.stringify(doc, null, 2))
}

async function runInstall(runtime = '/opt/bun/bin/bun'): Promise<void> {
  await install({ home, runtime, script: '/repo/src/install/notify.ts' })
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('5. 남의 설정', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'acm-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('훅 배열에 null 이 섞여 있어도 설치가 죽지 않는다', async () => {
    await seedClaude({
      hooks: { SessionStart: [{ hooks: [null, { type: 'command', command: 'other.sh' }] }] },
    })
    await runInstall()
    const doc = await readJson(claudePath())
    const cmds = doc.hooks.SessionStart.flatMap((e: any) =>
      (e.hooks ?? []).filter(Boolean).map((h: any) => h.command),
    )
    expect(cmds).toContain('other.sh')
  })

  test('같은 이벤트의 다른 모양 항목을 지우지 않는다', async () => {
    await seedClaude({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'keep.sh' }] },
          // hooks 배열이 없는 항목. 우리가 모르는 모양이지 남의 것이 아닌 건 아니다.
          { matcher: 'resume', command: 'legacy.sh' },
        ],
      },
    })
    await runInstall()
    const raw = await readFile(claudePath(), 'utf8')
    expect(raw).toContain('keep.sh')
    expect(raw).toContain('legacy.sh')
  })

  test('우리가 등록하지 않는 이벤트의 모르는 값은 그대로 둔다', async () => {
    await seedClaude({ hooks: { Stop: { a: 1 }, Notification: 'legacy-string-form' } })
    await runInstall()
    const doc = await readJson(claudePath())
    expect(doc.hooks.Stop).toEqual({ a: 1 })
    expect(doc.hooks.Notification).toBe('legacy-string-form')
  })

  test('우리가 등록할 이벤트가 배열이 아니면 덮지 않고 던진다', async () => {
    // 배열이 아닌 자리에 우리 항목을 얹을 방법이 없다. 조용히 덮으면 남의
    // 설정이 사라지므로, 읽지 못한 JSON 과 같이 손대지 않고 멈춘다.
    await seedClaude({ hooks: { SessionStart: 'legacy-string-form' } })
    await expect(runInstall()).rejects.toThrow('SessionStart')
    const raw = await readFile(claudePath(), 'utf8')
    expect(raw).toContain('legacy-string-form')
  })

  test('같은 matcher 항목 안에 남의 것과 우리 것이 섞여 있으면 남의 것만 남긴다', async () => {
    await seedClaude({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: 'their.sh' },
              { type: 'command', command: `/old/src${HOOK_MARKER}ts --event UserPromptSubmit` },
            ],
          },
        ],
      },
    })
    await runInstall()
    const doc = await readJson(claudePath())
    const cmds = doc.hooks.UserPromptSubmit.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(cmds).toContain('their.sh')
    expect(cmds.filter((c: string) => c.includes('/old/'))).toEqual([])
    expect(cmds.filter((c: string) => c.includes(HOOK_MARKER)).length).toBe(1)
  })

  test('type 이 command 가 아닌 항목을 남긴다', async () => {
    await seedClaude({
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'builtin', name: 'audit' }] }] },
    })
    await runInstall()
    const doc = await readJson(claudePath())
    const kinds = doc.hooks.PostToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.type))
    expect(kinds).toContain('builtin')
  })

  test('같은 이벤트의 여러 matcher 를 모두 남긴다', async () => {
    await seedClaude({
      hooks: {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh' }] },
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'b.sh' }] },
        ],
      },
    })
    await runInstall()
    const doc = await readJson(claudePath())
    const cmds = doc.hooks.PostToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(cmds).toContain('a.sh')
    expect(cmds).toContain('b.sh')
  })

  test('mergeHooks 는 모르는 모양을 그대로 돌려준다', () => {
    const foreign = { SessionStart: [{ matcher: 'x', command: 'legacy.sh' }] }
    expect(JSON.stringify(mergeHooks(foreign, {}))).toContain('legacy.sh')
  })
})

/* ================================================================== *
 * 6. 멱등성
 * ================================================================== */

describe('6. 멱등성', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'acm-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('세 번 돌려도 내용이 같다', async () => {
    await runInstall()
    const first = await readFile(claudePath(), 'utf8')
    const firstCodex = await readFile(codexPath(), 'utf8')
    await runInstall()
    await runInstall()
    expect(await readFile(claudePath(), 'utf8')).toBe(first)
    expect(await readFile(codexPath(), 'utf8')).toBe(firstCodex)
  })

  test('runtime 만 바뀌어도 항목이 늘지 않는다', async () => {
    await runInstall('/old/bun')
    await runInstall('/new/bun')
    await runInstall('/newer/bun')
    const doc = await readJson(claudePath())
    for (const event of Object.keys(doc.hooks)) {
      const cmds = doc.hooks[event].flatMap((e: any) => e.hooks.map((h: any) => h.command))
      expect(cmds.filter((c: string) => c.includes(HOOK_MARKER)).length).toBe(1)
      expect(cmds.some((c: string) => c.includes('/old/bun'))).toBe(false)
      expect(cmds.some((c: string) => c.includes('/new/bun') && !c.includes('/newer/'))).toBe(false)
    }
  })
})

/* ================================================================== *
 * 7. 권한 · 원자성
 * ================================================================== */

describe('7. 권한 · 원자성', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'acm-home-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test('원본 백업도 0600 이다', async () => {
    // settings.json 에는 apiKeyHelper·env·MCP 토큰이 들어간다. 본체를 0600 으로
    // 좁히면서 그 전문 사본을 0644 로 남기면 좁힌 의미가 없다.
    await seedClaude({ apiKeyHelper: 'echo $MY_SECRET', hooks: {} })
    await chmod(claudePath(), 0o600)
    await runInstall()
    const mode = (await stat(`${claudePath()}.acm-backup`)).mode & 0o777
    expect(mode.toString(8)).toBe('600')
  })

  test('쓰다 죽어도 반쪽 파일이 남지 않는다 — 임시 파일이 치워진다', async () => {
    await runInstall()
    for (const d of ['.claude', '.codex']) {
      const names = await readdir(join(home, d))
      expect(names.filter(n => n.endsWith('.tmp'))).toEqual([])
    }
  })

  test('JSON 이 깨져 있으면 원본도 임시 파일도 남기지 않는다', async () => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(codexPath(), '{ 깨짐 ')
    await expect(runInstall()).rejects.toThrow('JSON')
    expect(await readFile(codexPath(), 'utf8')).toBe('{ 깨짐 ')
    expect((await readdir(join(home, '.codex'))).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  test('한쪽이 실패하면 설치는 반쪽으로 남는다 (현재 동작 기록)', async () => {
    // install() 은 Claude 를 먼저 쓰고 Codex 를 나중에 쓴다. Codex 파일이
    // 깨져 있으면 전체가 예외로 죽지만 Claude 쪽은 이미 반영돼 있다 —
    // 사용자는 "설치 실패" 를 보고 다시 돌리는데, 그 사이 Claude 훅은 이미 돈다.
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(codexPath(), '{ 깨짐 ')
    await expect(runInstall()).rejects.toThrow('JSON')
    expect((await readFile(claudePath(), 'utf8')).includes(HOOK_MARKER)).toBe(true)
  })

  test('0644 이던 설정도 0600 으로 좁혀진다', async () => {
    await seedClaude({ model: 'opus' })
    await chmod(claudePath(), 0o644)
    await runInstall()
    expect(((await stat(claudePath())).mode & 0o777).toString(8)).toBe('600')
  })
})

/* ================================================================== *
 * 8. 훅이 세션을 세우지 않는다 (진짜 서브프로세스)
 * ================================================================== */

interface HookRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function runNotify(env: Record<string, string>, event = 'UserPromptSubmit'): Promise<HookRun> {
  const proc = Bun.spawn(['bun', 'run', NOTIFY, '--event', event], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

const HOOK_SEED = '11'.repeat(32)

async function writeConfig(path: string, storeDir: string, mode = 0o600): Promise<void> {
  await writeFile(path, JSON.stringify({ seed: HOOK_SEED, channels: [], store: { dir: storeDir } }), {
    mode,
  })
  await chmod(path, mode)
}

/**
 * 훅이 실제로 여는 자리.
 *
 * 설정의 `store.dir` 이 그대로 저장 위치가 아니다 — 그 아래 지문 한 칸이
 * 붙는다(§6.3). 바깥 디렉토리에 심으면 훅은 빈 저장소를 보고, 통과가 공허해진다.
 */
async function storePathOf(dir: string): Promise<string> {
  return join(dir, toKey((await deriveIdentity(fromHex(HOOK_SEED, 32))).fingerprint))
}

describe('8. 훅은 어떤 실패에서도 세션을 세우지 않는다', () => {
  test('설정 권한이 0644 여도 0 으로 끝나고 유효한 JSON 을 낸다', async () => {
    const cfg = join(dir, 'wide.json')
    await writeConfig(cfg, join(dir, 'messages'), 0o644)
    const r = await runNotify({ ACM_CONFIG: cfg })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ continue: true, suppressOutput: true })
  }, 30_000)

  test('저장소 디렉토리 권한이 없어도 0 으로 끝난다', async () => {
    const storeDir = join(dir, 'locked')
    await mkdir(storeDir, { recursive: true, mode: 0o700 })
    const cfg = join(dir, 'ok.json')
    await writeConfig(cfg, storeDir)
    await chmod(storeDir, 0o000)
    try {
      const r = await runNotify({ ACM_CONFIG: cfg })
      expect(r.code).toBe(0)
      expect(() => JSON.parse(r.stdout)).not.toThrow()
    } finally {
      await chmod(storeDir, 0o700)
    }
  }, 30_000)

  test('설정 JSON 이 깨져 있어도 0 으로 끝난다', async () => {
    const cfg = join(dir, 'broken.json')
    await writeFile(cfg, '{ 깨짐 ', { mode: 0o600 })
    await chmod(cfg, 0o600)
    const r = await runNotify({ ACM_CONFIG: cfg })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ continue: true, suppressOutput: true })
  }, 30_000)

  test('저장소 파일이 깨져 있어도 0 으로 끝난다', async () => {
    const storeDir = join(dir, 'messages')
    const opened = await storePathOf(storeDir)
    await mkdir(opened, { recursive: true, mode: 0o700 })
    const f = join(opened, `${A}.json`)
    await writeFile(f, '{ 깨짐 ', { mode: 0o600 })
    await chmod(f, 0o600)
    const cfg = join(dir, 'ok2.json')
    await writeConfig(cfg, storeDir)
    const r = await runNotify({ ACM_CONFIG: cfg })
    expect(r.code).toBe(0)
    expect(() => JSON.parse(r.stdout)).not.toThrow()
  }, 30_000)

  test('정상 경로에서는 실제로 컨텍스트를 싣는다 — 위 통과가 공허하지 않다', async () => {
    const storeDir = join(dir, 'messages')
    const s = new MessageStore({ dir: await storePathOf(storeDir) })
    await s.append(inbound({ text: '서브프로세스가 본 말' }))
    const cfg = join(dir, 'ok3.json')
    await writeConfig(cfg, storeDir)
    const r = await runNotify({ ACM_CONFIG: cfg })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput?.additionalContext).toContain('서브프로세스가 본 말')
  }, 30_000)
})
