/**
 * 훅 설치기 테스트 (§6.6「훅은 설치 대상이다」)
 *
 * 설치기가 손대는 것은 **사용자의 에이전트 설정 파일**이다. 여기서 지키는 것은
 * 두 가지 — 남의 훅을 지우지 않는 것, 그리고 여러 번 돌려도 결과가 같은 것
 * (안 그러면 같은 알림이 두 번 세 번 뜬다).
 *
 * 진짜 홈을 절대 건드리지 않는다. 모든 테스트가 임시 홈을 판다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  install,
  mergeHooks,
  hookCommand,
  parseFlag,
  checkArgs,
  HOOK_MARKER,
  HOOK_EVENTS,
} from '../src/install/hooks.js'
import { HOOK_CONTEXT_LIMIT } from '../src/install/notify.js'

let home: string

const SCRIPT = '/repo/src/install/notify.ts'
const RUNTIME = '/opt/bun/bin/bun'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'acm-home-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const claudePath = () => join(home, '.claude', 'settings.json')
const codexPath = () => join(home, '.codex', 'hooks.json')

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function run(dryRun = false) {
  return install({ home, script: SCRIPT, runtime: RUNTIME, dryRun })
}

/** 명령 문자열에 우리 표식이 든 항목만 센다. */
function ours(doc: any): string[] {
  return Object.entries(doc.hooks ?? {}).flatMap(([event, entries]: [string, any]) =>
    entries.flatMap((e: any) =>
      e.hooks.filter((h: any) => h.command.includes(HOOK_MARKER)).map(() => event),
    ),
  )
}

describe('설치', () => {
  test('두 에이전트 모두에 등록한다', async () => {
    await run()
    for (const doc of [await readJson(claudePath()), await readJson(codexPath())]) {
      expect(Object.keys(doc.hooks).sort()).toEqual([
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'UserPromptSubmit',
      ])
    }
  })

  test('bun 을 이름이 아니라 절대경로로 부른다', async () => {
    // 훅은 에이전트가 물려주는 환경에서 돈다. 그 PATH 에 bun 이 없으면
    // 등록은 됐는데 매번 조용히 실패한다.
    await run()
    const cmd = (await readJson(claudePath())).hooks.SessionStart[0].hooks[0].command
    expect(cmd).toContain(`"${RUNTIME}" run`)
    expect(cmd).toContain(SCRIPT)
    expect(cmd).toContain('--event SessionStart')
  })

  test('SessionStart 는 재개·압축까지 받는다', async () => {
    await run()
    expect((await readJson(claudePath())).hooks.SessionStart[0].matcher).toBe(
      'startup|resume|clear|compact',
    )
  })

  test('Codex 에 async 를 달지 않는다 — 달면 훅이 목록에서 통째로 빠진다', async () => {
    // Codex 0.147 은 async 훅을 지원하지 않고, 만나면 등록 목록에서 빼 버린
    // 뒤 경고 한 줄만 남긴다(`hooks/list` 의 warnings). 파일에는 남아 있는데
    // 한 번도 돌지 않으므로 눈으로는 정상으로 보인다.
    await run()
    expect(JSON.stringify(await readJson(codexPath()))).not.toContain('"async"')
  })

  test('Codex 컨텍스트 한도를 훅 예산보다 넉넉히 잡는다', async () => {
    const entry = (await run(), (await readJson(codexPath())).hooks.PostToolUse[0].hooks[0])
    expect(entry.timeout).toBeGreaterThan(0)
    // 여기가 더 좁으면 Codex 가 말 중간에서 잘라 내고, 메시지 단위로 끊어 둔
    // 의미가 사라진다.
    expect(entry.additionalContextLimit).toBeGreaterThan(HOOK_CONTEXT_LIMIT)
  })

  test('Codex 조정값을 camelCase 로 쓴다', async () => {
    // `timeout_sec` · `additional_context_limit` 이라는 이름도 바이너리에
    // 있지만 설정 파일 파서는 그것을 읽지 않는다 — 조용히 버리고 기본값
    // (600초 · 무제한)으로 떨어진다.
    await run()
    const text = JSON.stringify(await readJson(codexPath()))
    expect(text).not.toContain('timeout_sec')
    expect(text).not.toContain('additional_context_limit')
    expect(text).toContain('additionalContextLimit')
  })

  test('Claude 는 async 키를 넣지 않는다 — 모르는 키다', async () => {
    await run()
    expect((await readJson(claudePath())).hooks.SessionStart[0].hooks[0].async).toBeUndefined()
  })

  test('0600 으로 쓴다', async () => {
    await run()
    for (const p of [claudePath(), codexPath()]) {
      expect((await stat(p)).mode & 0o777).toBe(0o600)
    }
  })

  test('경로에 큰따옴표가 있으면 명령을 만들지 않고 던진다', () => {
    expect(() => hookCommand(RUNTIME, '/re"po/notify.ts', 'Stop')).toThrow('큰따옴표')
  })
})

describe('여러 번 돌려도 같다', () => {
  test('두 번 돌려도 항목이 늘지 않는다', async () => {
    await run()
    await run()
    expect(ours(await readJson(claudePath()))).toHaveLength(HOOK_EVENTS.length)
    expect(ours(await readJson(codexPath()))).toHaveLength(HOOK_EVENTS.length)
  })

  test('레포를 옮겨도 옛 항목이 남지 않는다', async () => {
    await run()
    await install({ home, script: '/moved/src/install/notify.ts', runtime: RUNTIME })
    const doc = await readJson(claudePath())
    expect(ours(doc)).toHaveLength(HOOK_EVENTS.length)
    // 남아 있으면 같은 메시지가 두 번 뜬다.
    const cmds = doc.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(cmds.some((c: string) => c.includes('/repo/'))).toBe(false)
    expect(cmds.some((c: string) => c.includes('/moved/'))).toBe(true)
  })
})

describe('남의 설정을 건드리지 않는다', () => {
  test('다른 플러그인의 훅을 남긴다', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(
      claudePath(),
      JSON.stringify({
        model: 'opus',
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'other-plugin --hi' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'gate.sh' }] }],
        },
      }),
    )

    await run()
    const doc = await readJson(claudePath())

    expect(doc.model).toBe('opus') // hooks 밖의 설정도 그대로다
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toBe('gate.sh')
    const session = doc.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command))
    expect(session).toContain('other-plugin --hi')
    expect(session.some((c: string) => c.includes(HOOK_MARKER))).toBe(true)
  })

  test('처음 손댈 때 원본을 남긴다', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(claudePath(), '{"model":"opus"}')

    const [claude] = await run()
    expect(claude!.backup).toBe(`${claudePath()}.acm-backup`)
    expect(await readFile(claude!.backup!, 'utf8')).toBe('{"model":"opus"}')
  })

  test('두 번째 실행이 백업을 덮어쓰지 않는다', async () => {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(claudePath(), '{"model":"opus"}')

    await run()
    const [claude] = await run()
    // 갈아 끼우면 진짜 원본이 사라진다 — 되돌릴 곳 없는 백업은 백업이 아니다.
    expect(claude!.backup).toBeUndefined()
    expect(await readFile(`${claudePath()}.acm-backup`, 'utf8')).toBe('{"model":"opus"}')
  })

  test('읽을 수 없는 JSON 은 덮어쓰지 않고 던진다', async () => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(codexPath(), '{ 망가진 ')

    await expect(run()).rejects.toThrow('JSON')
    expect(await readFile(codexPath(), 'utf8')).toBe('{ 망가진 ')
  })

  test('모르는 모양의 훅 항목도 지우지 않는다', async () => {
    await mkdir(join(home, '.codex'), { recursive: true })
    await writeFile(
      codexPath(),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'bye' }] }] } }),
    )
    await run()
    expect((await readJson(codexPath())).hooks.SessionEnd[0].hooks[0].command).toBe('bye')
  })
})

describe('--dry-run', () => {
  test('아무 파일도 쓰지 않는다', async () => {
    const results = await run(true)
    expect(results.every(r => !r.written)).toBe(true)
    for (const p of [claudePath(), codexPath()]) {
      await expect(stat(p)).rejects.toThrow()
    }
    expect(results[0]!.content).toContain(HOOK_MARKER)
  })
})

describe('mergeHooks', () => {
  test('훅이 다 빠진 항목은 통째로 없앤다', () => {
    const before = {
      SessionStart: [{ hooks: [{ type: 'command', command: `x${HOOK_MARKER}ts` }] }],
    }
    expect(mergeHooks(before, {})).toEqual({})
  })

  test('배열이 아닌 값은 그대로 둔다 — 남의 설정이다', () => {
    expect(mergeHooks({ SessionStart: 'nope' }, {})).toEqual({ SessionStart: 'nope' })
  })

  test('없던 파일(undefined)도 받는다', () => {
    const ours = { Stop: [{ hooks: [{ type: 'command' as const, command: 'c' }] }] }
    expect(mergeHooks(undefined, ours)).toEqual(ours)
  })
})

/**
 * 에이전트별 신원 (§6.4)
 *
 * 지키는 것은 하나다 — **한 기계의 두 에이전트를 서로 다른 참여자로 세울 수
 * 있어야 한다.** 그러지 못하면 둘이 같은 저장소를 보고, 도착한 메시지를
 * `claimUndelivered` 가 먼저 집는 쪽에 준다. 그건 유실이 아니라 오배달이라
 * 어느 화면에도 이상이 보이지 않는다.
 */
describe('에이전트별 설정 (§6.4)', () => {
  const CLAUDE_CFG = '/home/me/.agent-channel-mesh/claude.json'
  const CODEX_CFG = '/home/me/.agent-channel-mesh/codex.json'

  test('주지 않으면 --config 가 붙지 않는다 — 에이전트 하나만 쓰는 경우가 기본이다', async () => {
    await run()
    for (const p of [claudePath(), codexPath()]) {
      const doc = await readJson(p)
      const commands = Object.values(doc.hooks).flatMap((entries: any) =>
        entries.flatMap((e: any) => e.hooks.map((h: any) => h.command)),
      )
      expect(commands.length).toBeGreaterThan(0)
      expect(commands.every((c: string) => !c.includes('--config'))).toBe(true)
    }
  })

  test('주면 각자 자기 것을 읽는다', async () => {
    await install({
      home,
      script: SCRIPT,
      runtime: RUNTIME,
      claudeConfig: CLAUDE_CFG,
      codexConfig: CODEX_CFG,
    })

    const claude = await readJson(claudePath())
    const codex = await readJson(codexPath())
    const commandsOf = (doc: any) =>
      Object.values(doc.hooks).flatMap((entries: any) =>
        entries.flatMap((e: any) => e.hooks.map((h: any) => h.command)),
      ) as string[]

    // 모든 이벤트에 빠짐없이 실려야 한다. 하나라도 빠지면 그 이벤트에서만
    // 남의 신원으로 도는, 재현이 어려운 형태의 고장이 된다.
    expect(commandsOf(claude).every(c => c.includes(`--config "${CLAUDE_CFG}"`))).toBe(true)
    expect(commandsOf(codex).every(c => c.includes(`--config "${CODEX_CFG}"`))).toBe(true)
    expect(commandsOf(claude).some(c => c.includes(CODEX_CFG))).toBe(false)
  })

  test('둘에 같은 경로를 주면 쓰기 전에 죽는다', async () => {
    await expect(
      install({ home, script: SCRIPT, runtime: RUNTIME, claudeConfig: '/x.json', codexConfig: '/x.json' }),
    ).rejects.toThrow(/같은 설정 파일/)
  })

  test('설정 경로의 큰따옴표는 명령을 만들기 전에 막는다', () => {
    expect(() => hookCommand(RUNTIME, SCRIPT, 'Stop', '/a"b.json')).toThrow(/큰따옴표/)
  })
})

/**
 * 설치기 인자 (§6.4)
 *
 * `--claude-cofnig` 같은 오타가 무시되면 설치는 "성공했다"고 출력하면서
 * 두 에이전트를 같은 신원으로 묶는다. 그 고장은 화면 어디에도 안 보이므로,
 * 모르는 인자는 반드시 실패로 끝나야 한다.
 */
describe('설치기 인자', () => {
  test('아는 인자만 있으면 통과한다', () => {
    expect(() =>
      checkArgs(['--dry-run', '--claude-config', '/a.json', '--codex-config', '/b.json']),
    ).not.toThrow()
    expect(() => checkArgs([])).not.toThrow()
  })

  test('오타는 조용히 무시되지 않는다', () => {
    expect(() => checkArgs(['--claude-cofnig', '/a.json'])).toThrow(/모르는 인자/)
  })

  test('플래그의 값은 인자로 오해하지 않는다', () => {
    // 값이 `--` 로 시작하지 않는 한 그것을 모르는 인자로 세면 안 된다.
    expect(() => checkArgs(['--codex-config', 'codex.json'])).not.toThrow()
  })

  test('값이 없는 플래그는 다음 플래그를 값으로 삼지 않는다', () => {
    expect(() => parseFlag(['--claude-config', '--dry-run'], '--claude-config')).toThrow(/값이 없다/)
    expect(() => parseFlag(['--claude-config'], '--claude-config')).toThrow(/값이 없다/)
  })

  test('플래그가 없으면 undefined — 기본 경로를 쓴다', () => {
    expect(parseFlag(['--dry-run'], '--claude-config')).toBeUndefined()
  })
})
