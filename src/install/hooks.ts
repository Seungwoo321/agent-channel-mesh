/**
 * 훅 설치기 — 두 에이전트에 안전망을 등록한다
 *
 * 설계 근거는 docs/architecture.md §6.6「훅은 설치 대상이다」.
 *
 * MCP 서버는 세션에 먼저 말을 걸지 못한다. 그래서 알림 경로를 따로 등록해야
 * 하는데, 이 등록이 빠지면 **"MCP 는 붙었는데 알림만 안 오는"** 상태가 된다 —
 * 툴이 응답하므로 고장으로 보이지 않고, 사용자는 상대가 조용한 줄 안다.
 * §4 가 전달 방식을 명시로만 정하는 것과 같은 이유로 이 상태를 허용하지 않는다.
 *
 * **두 에이전트가 같은 형식을 쓴다.** `hooks.json` 구조와 이벤트 이름이
 * 호환되고, 둘 다 `hookSpecificOutput.additionalContext` 로 모델 컨텍스트에
 * 들어간다. 그래서 스크립트는 하나이고 등록 자리만 다르다.
 *
 * | 에이전트 | 등록 자리 |
 * |---|---|
 * | Claude Code | `~/.claude/settings.json` 의 `hooks` 키 |
 * | Codex | `~/.codex/hooks.json` |
 *
 * **남의 훅을 건드리지 않는다.** 기존 파일을 통째로 덮으면 다른 플러그인의
 * 훅이 사라지고, 그건 우리가 고칠 수 없는 남의 고장이 된다. 우리 항목만
 * 표식으로 골라 지우고 다시 넣는다 — 그래서 몇 번 돌려도 결과가 같다.
 */
import { mkdir, readFile, rename, writeFile, chmod, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * 우리 항목을 알아보는 표식.
 *
 * 명령 문자열 전체로 대조하지 않는다 — 레포를 옮기거나 `bun` 경로가 바뀌면
 * 명령이 달라져 예전 항목을 못 지우고 **훅이 두 벌 등록된다**(같은 메시지가
 * 두 번 뜬다). 경로 꼬리는 그 변화들을 타지 않는다.
 */
export const HOOK_MARKER = '/install/notify.'

/** Codex 훅 실행 상한(초). 저장소 파일 몇 개를 읽는 일이라 넉넉하다. */
const CODEX_TIMEOUT_SEC = 10

/**
 * Codex 가 컨텍스트에 실어 주는 최대 글자 수.
 *
 * 훅 쪽 예산({@link HOOK_CONTEXT_LIMIT})보다 넉넉해야 한다. 여기가 더 좁으면
 * Codex 가 **말 중간에서** 잘라 내고, 우리가 메시지 단위로 끊어 둔 의미가
 * 없어진다.
 */
const CODEX_CONTEXT_LIMIT = 12_000

/**
 * 등록할 이벤트.
 *
 * §6.6 의 세 상황을 각각 덮는다. 하나로 줄이면 그 하나가 안 도는 상황이
 * 통째로 사각이 된다.
 * - `SessionStart` — 세션을 열었을 때 밀려 있던 것
 * - `UserPromptSubmit` — 유휴 세션이 다음 프롬프트를 받을 때
 * - `PostToolUse` — 긴 턴이 도는 중(턴 경계를 기다리지 않는다)
 */
export const HOOK_EVENTS: readonly { readonly name: string; readonly matcher?: string }[] = [
  { name: 'SessionStart', matcher: 'startup|resume|clear|compact' },
  { name: 'UserPromptSubmit' },
  { name: 'PostToolUse', matcher: '.*' },
]

interface CommandEntry {
  readonly type: 'command'
  readonly command: string
  readonly async?: boolean
  readonly timeout?: number
  readonly additionalContextLimit?: number
}

interface MatcherEntry {
  readonly matcher?: string
  readonly hooks: readonly CommandEntry[]
}

type HookMap = Record<string, MatcherEntry[]>

/**
 * 병합 결과.
 *
 * 값이 `MatcherEntry[]` 라고 단정하지 않는다 — 우리가 모르는 모양이 그대로
 * 섞여 있을 수 있고, **그대로 두는 것이 요점**이다. 타입을 좁히면 그 순간
 * 모르는 값을 버리는 코드가 자연스러워진다.
 */
type MergedHooks = Record<string, unknown>

/**
 * 훅을 실행하는 명령 한 줄.
 *
 * `bun` 을 이름으로 부르지 않고 **지금 도는 실행 파일의 절대경로**를 박는다.
 * 훅은 에이전트가 물려주는 환경에서 돌고, 그 `PATH` 에 `bun` 이 없을 수 있다.
 * 그러면 훅은 등록됐는데 매번 조용히 실패한다 — 정확히 이 설치기가 막으려는
 * "동작하는 것처럼 보이는 고장"이다.
 */
export function hookCommand(runtime: string, script: string, event: string): string {
  for (const p of [runtime, script]) {
    if (p.includes('"')) throw new Error(`경로에 큰따옴표가 있어 명령을 만들 수 없다: ${p}`)
  }
  return `"${runtime}" run "${script}" --event ${event}`
}

/** Claude Code 의 `hooks` 값. matcher 가 없는 이벤트는 키 자체를 뺀다. */
export function claudeHooks(runtime: string, script: string): HookMap {
  const out: HookMap = {}
  for (const e of HOOK_EVENTS) {
    out[e.name] = [
      {
        ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
        hooks: [{ type: 'command', command: hookCommand(runtime, script, e.name) }],
      },
    ]
  }
  return out
}

/**
 * Codex 의 `hooks` 값.
 *
 * `async: true` 가 기본이다 — async 훅의 결과는 프롬프트 직전뿐 아니라 **모델
 * 샘플링 루프 안에서도** 회수된다. 긴 작업을 도는 세션이 턴 경계를 기다리지
 * 않고 알림을 받는 유일한 길이다 (§6.6).
 */
export function codexHooks(runtime: string, script: string): HookMap {
  const out: HookMap = {}
  for (const e of HOOK_EVENTS) {
    out[e.name] = [
      {
        ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
        hooks: [
          {
            type: 'command',
            command: hookCommand(runtime, script, e.name),
            async: true,
            timeout: CODEX_TIMEOUT_SEC,
            additionalContextLimit: CODEX_CONTEXT_LIMIT,
          },
        ],
      },
    ]
  }
  return out
}

/**
 * 기존 훅에 우리 것을 얹는다. **우리 항목만** 갈아 끼운다.
 *
 * 먼저 표식이 든 항목을 전부 걷어낸 뒤 새로 넣는다. 이렇게 해야 여러 번
 * 돌려도 항목이 쌓이지 않고(= 같은 알림이 n번), 경로가 바뀐 옛 항목도
 * 같이 사라진다.
 */
export function mergeHooks(existing: unknown, ours: HookMap): MergedHooks {
  const out: MergedHooks = {}

  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    for (const [event, value] of Object.entries(existing as Record<string, unknown>)) {
      const kept = stripOurs(value)
      if (kept !== undefined) out[event] = kept
    }
  }

  for (const [event, entries] of Object.entries(ours)) {
    const prev = out[event]
    if (prev === undefined) {
      out[event] = entries
      continue
    }
    if (!Array.isArray(prev)) {
      // 배열이 아닌 자리에 우리 항목을 얹을 방법이 없다. 덮으면 남의 설정이
      // 사라지므로, 읽지 못한 JSON 과 같이 **쓰지 않고 던진다**.
      throw new Error(
        `훅 설정의 ${event} 가 배열이 아니라 우리 항목을 얹을 수 없다. ` +
          `덮어쓰지 않았다 — 그 항목을 정리한 뒤 다시 실행해라.`,
      )
    }
    out[event] = [...prev, ...entries]
  }
  return out
}

function isOurs(hook: unknown): boolean {
  if (typeof hook !== 'object' || hook === null) return false
  const command = (hook as { command?: unknown }).command
  return typeof command === 'string' && command.includes(HOOK_MARKER)
}

/**
 * 한 이벤트의 값에서 **우리 항목만** 걷어낸다.
 *
 * 모르는 모양은 손대지 않는다 — 배열이 아닌 값도, `hooks` 배열이 없는 항목도,
 * `type` 이 `command` 가 아닌 훅도 남의 것이다. 우리가 이해 못 하는 모양을
 * 정리하는 것은 정리가 아니라 파괴다.
 *
 * 원래 있던 항목이 **전부** 우리 것이었으면 `undefined` 를 돌려준다 — 그러면
 * 그 이벤트 키 자체가 사라지고, 우리가 등록하지 않는 이벤트에 빈 배열이
 * 남지 않는다.
 */
function stripOurs(value: unknown): unknown {
  if (!Array.isArray(value)) return value

  const kept = value.map(stripEntry).filter(entry => entry !== undefined)
  if (kept.length === 0 && value.length > 0) return undefined
  return kept
}

function stripEntry(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return entry

  const hooks = (entry as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return entry

  const kept = hooks.filter(h => !isOurs(h))
  // 원래 비어 있던 항목까지 없애지는 않는다 — 우리 것이 있었던 자리만 지운다.
  if (kept.length === 0 && hooks.length > 0) return undefined
  return { ...entry, hooks: kept }
}

export interface InstallOptions {
  /** 홈 디렉토리. 테스트에서만 준다. */
  readonly home?: string
  /** 훅 스크립트 절대경로. 생략하면 이 파일 옆의 `notify` 를 찾는다. */
  readonly script?: string
  /** Bun 실행 파일 경로. 생략하면 지금 도는 것. */
  readonly runtime?: string
  /** 쓰지 않고 계획만 만든다. */
  readonly dryRun?: boolean
}

export interface InstallResult {
  readonly path: string
  readonly agent: 'claude' | 'codex'
  /** 실제로 파일을 썼는지. dry-run 이면 항상 `false`. */
  readonly written: boolean
  /** 처음 손대는 파일이라 원본을 남겼다면 그 자리. */
  readonly backup?: string
  readonly content: string
}

/**
 * 두 에이전트에 등록한다.
 *
 * 한쪽 에이전트가 안 깔려 있어도 등록한다 — 나중에 깔았을 때 알림이 도는
 * 편이, "왜 조용하지"를 다시 겪는 것보다 낫다. 디렉토리는 만들어 준다.
 */
export async function install(options: InstallOptions = {}): Promise<InstallResult[]> {
  const home = options.home ?? process.env.HOME ?? ''
  if (home === '') throw new Error('홈 디렉토리를 알 수 없다 — HOME 이 비어 있다.')

  const runtime = options.runtime ?? process.execPath
  const script = options.script ?? (await findScript())

  return [
    await writeClaude(join(home, '.claude', 'settings.json'), runtime, script, options.dryRun),
    await writeCodex(join(home, '.codex', 'hooks.json'), runtime, script, options.dryRun),
  ]
}

/**
 * Claude 쪽은 **설정 파일 안의 한 키**다.
 *
 * 파일 전체가 우리 것이 아니므로 `hooks` 만 바꾸고 나머지는 읽은 그대로 둔다.
 * 파싱이 안 되면 **쓰지 않고 던진다** — 사용자의 설정을 우리가 이해 못 한
 * 채로 덮는 것은 복구가 안 되는 손해다.
 */
async function writeClaude(
  path: string,
  runtime: string,
  script: string,
  dryRun = false,
): Promise<InstallResult> {
  const raw = await readJson(path)
  const doc = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {}
  const merged = mergeHooks((doc as { hooks?: unknown }).hooks, claudeHooks(runtime, script))
  const content = `${JSON.stringify({ ...doc, hooks: merged }, null, 2)}\n`

  const backup = dryRun ? undefined : await save(path, content)
  return { path, agent: 'claude', written: !dryRun, ...(backup ? { backup } : {}), content }
}

/** Codex 쪽은 **파일 하나가 통째로 훅 문서**다. `description` 이 최상위에 온다. */
async function writeCodex(
  path: string,
  runtime: string,
  script: string,
  dryRun = false,
): Promise<InstallResult> {
  const raw = await readJson(path)
  const doc = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {}
  const merged = mergeHooks((doc as { hooks?: unknown }).hooks, codexHooks(runtime, script))
  const content = `${JSON.stringify(
    { description: 'agent-channel-mesh — 도착한 메시지를 세션에 알린다', ...doc, hooks: merged },
    null,
    2,
  )}\n`

  const backup = dryRun ? undefined : await save(path, content)
  return { path, agent: 'codex', written: !dryRun, ...(backup ? { backup } : {}), content }
}

async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(
      `${path} 를 JSON 으로 읽지 못했다 (${String(e)}). ` +
        `덮어쓰지 않았다 — 파일을 고친 뒤 다시 실행해라.`,
    )
  }
}

/**
 * 원자적으로 쓴다. 처음 손대는 파일이면 **원본을 한 번만** 남긴다.
 *
 * 매번 백업을 갈아 끼우면 두 번째 실행에서 진짜 원본이 사라진다 — 되돌릴 곳이
 * 없어지는 백업은 백업이 아니다.
 */
async function save(path: string, content: string): Promise<string | undefined> {
  await mkdir(dirname(path), { recursive: true })

  let backup: string | undefined
  const original = `${path}.acm-backup`
  if ((await exists(path)) && !(await exists(original))) {
    // 백업도 0600 이다. 원본에는 `apiKeyHelper` · `env` · MCP 토큰이 들어
    // 있는데, 본체를 좁히면서 전문 사본을 0644 로 남기면 좁힌 의미가 없다.
    await writeFile(original, await readFile(path), { mode: 0o600 })
    await chmod(original, 0o600)
    backup = original
  }

  // temp + rename. 쓰다 죽어도 반쪽짜리 설정 파일이 남지 않는다.
  const temp = `${path}.${String(process.pid)}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
  return backup
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 배포 형태에 따라 `.ts` 이거나 `.js` 다. 있는 쪽을 쓴다. */
async function findScript(): Promise<string> {
  for (const name of ['notify.ts', 'notify.js']) {
    const p = resolve(import.meta.dir, name)
    if (await exists(p)) return p
  }
  throw new Error(`훅 스크립트를 찾지 못했다: ${import.meta.dir}/notify.(ts|js)`)
}

/**
 * Codex 는 훅에 **trust 승인**을 요구한다.
 *
 * 승인 전에는 훅이 등록만 되고 실행되지 않는다 — 또다시 "MCP 는 붙었는데
 * 알림만 안 오는" 상태다. 그래서 설치가 끝나면 이 안내를 반드시 낸다.
 *
 * `--dangerously-bypass-hook-trust` 는 안내하지 않는다. 신뢰 검사를 끄는 것은
 * 우리 훅 하나가 아니라 **모든 훅**을 무검증으로 돌리는 일이라, 알림 편의와
 * 바꿀 것이 아니다.
 */
export const CODEX_TRUST_NOTE =
  'Codex 는 훅에 trust 승인이 필요하다. Codex 에서 `/hooks` 를 열어 승인해라.\n' +
  '승인 전에는 등록만 되고 실행되지 않는다 — 툴은 붙었는데 알림만 안 오는 상태가 된다.\n' +
  '훅 스크립트를 고치면 해시가 바뀌어 다시 승인해야 한다.'

async function main(argv: readonly string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run')
  const results = await install({ dryRun })

  for (const r of results) {
    process.stdout.write(
      dryRun
        ? `[예정] ${r.agent} · ${r.path}\n${r.content}\n`
        : `설치했다: ${r.agent} · ${r.path}${r.backup ? ` (원본 백업 ${r.backup})` : ''}\n`,
    )
  }
  if (!dryRun) process.stdout.write(`\n${CODEX_TRUST_NOTE}\n`)
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`[agent-channel-mesh] 훅 설치에 실패했다: ${String(e)}\n`)
    process.exit(1)
  })
}
