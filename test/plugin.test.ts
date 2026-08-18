/**
 * 플러그인 산출물이 생성기와 어긋나지 않는지 지킨다.
 *
 * 매니페스트·훅·번들은 **커밋된 파일**이 곧 배포물이라, 생성기를 고치고 다시
 * 돌리지 않으면 아무도 모르는 채로 옛 파일이 나간다. 반대로 파일만 손으로
 * 고치면 다음 생성에서 조용히 되돌아간다. 어느 쪽이든 "설치 경로마다 동작이
 * 갈리는" 고장이라, 여기서 대조해 둔다.
 */
import { test, expect, describe } from 'bun:test'
import {
  claudeManifest,
  codexManifest,
  marketplaceManifest,
  pluginHooks,
  runnerCommand,
  buildBundle,
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  MARKETPLACE_MANIFEST,
  PLUGIN_HOOKS,
  PLUGIN_BUNDLE,
  PLUGIN_DIR,
  PACKAGE_NAME,
} from '../src/install/plugin.js'
import { HOOK_EVENTS } from '../src/install/hooks.js'

const pkg = (await Bun.file('package.json').json()) as { version: string; name: string }
const version = pkg.version

async function committed(path: string): Promise<unknown> {
  return await Bun.file(path).json()
}

type McpServer = { command: string; args: string[]; cwd?: string }
const serverOf = (manifest: unknown): McpServer =>
  (manifest as { mcpServers: Record<string, McpServer> }).mcpServers[PACKAGE_NAME]!

describe('커밋된 산출물 = 생성 결과', () => {
  const cases: readonly [string, unknown][] = [
    [CLAUDE_MANIFEST, claudeManifest(version)],
    [CODEX_MANIFEST, codexManifest(version)],
    [MARKETPLACE_MANIFEST, marketplaceManifest(version)],
    [PLUGIN_HOOKS, pluginHooks()],
  ]

  for (const [path, expected] of cases) {
    test(`${path} 가 최신이다`, async () => {
      // 어긋나면 `bun run plugin` 을 다시 돌려라.
      expect(await committed(path)).toEqual(expected as Record<string, unknown>)
    })
  }

  test(`${PLUGIN_BUNDLE} 가 지금 소스에서 나온 것과 같다`, async () => {
    // 번들은 커밋돼 있고, 팀원 쪽에서 도는 것은 소스가 아니라 이 파일이다.
    // 소스만 고치고 다시 뽑지 않으면 **고친 적 없는 코드가 배포된다** —
    // 레포를 읽어서는 드러나지 않는 어긋남이라 바이트로 대조한다.
    const before = await Bun.file(PLUGIN_BUNDLE).bytes()
    await buildBundle()
    const after = await Bun.file(PLUGIN_BUNDLE).bytes()
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true)
  })
})

describe('번들', () => {
  test('의존성을 안에 품는다 — 플러그인은 설치 단계가 없다', async () => {
    // 플러그인은 클론만 되고 `bun install` 이 일어나지 않는다. 번들이 밖의
    // 모듈을 부르는 순간, 설치한 사람 쪽에서 첫 실행에 죽는다.
    const text = await Bun.file(PLUGIN_BUNDLE).text()
    for (const dep of ['@hpke/', '@noble/', '@modelcontextprotocol/', 'zod']) {
      expect(text).not.toContain(`from"${dep}`)
      expect(text).not.toContain(`from "${dep}"`)
      expect(text).not.toContain(`require("${dep}")`)
    }
  })

  test('압축하지 않는다 — 읽어서 확인할 수 있어야 한다', async () => {
    // 남의 기계에서 도는 암호 코드다. 크기보다 검증 가능성이 앞선다.
    const text = await Bun.file(PLUGIN_BUNDLE).text()
    const lines = text.split('\n').length
    expect(lines).toBeGreaterThan(1000)
  })
})

describe('실행 명령', () => {
  test('플러그인 이름이 패키지 이름과 같다', () => {
    expect(pkg.name).toBe(PACKAGE_NAME)
  })

  test('레지스트리를 타지 않는다', () => {
    // 번들이 곧 실행물이다. `bunx <패키지>@<버전>` 이면 핀이 둘로 갈린다 —
    // 마켓플레이스는 git ref 로 파일을 주는데 도는 코드는 npm 에서 온다.
    expect(runnerCommand()).not.toContain('bunx')
    expect(runnerCommand()).not.toContain('npx')
    expect(runnerCommand()).not.toContain('latest')
  })

  test('플러그인 루트 기준으로 번들을 가리킨다', () => {
    // 설치 경로는 생성 시점에 알 수 없다. 절대경로를 박으면 만든 사람
    // 기계에서만 돈다.
    expect(runnerCommand()).toBe('bun "${CLAUDE_PLUGIN_ROOT}/dist/acm.js"')
  })

  test('경로를 따옴표로 감싼다', () => {
    // 훅 명령은 셸을 거친다. 홈 경로에 공백이 있으면 두 인자로 쪼개진다.
    expect(runnerCommand()).toContain('"${CLAUDE_PLUGIN_ROOT}')
  })

  test('매니페스트 버전이 package.json 과 같다', async () => {
    for (const path of [CLAUDE_MANIFEST, CODEX_MANIFEST]) {
      expect((await committed(path)) as { version: string }).toMatchObject({ version })
    }
  })
})

describe('훅', () => {
  test('설치기와 같은 이벤트를 덮는다', () => {
    // 한쪽에만 이벤트를 추가하면 설치기로 깐 사람에게만 알림이 온다.
    expect(Object.keys(pluginHooks().hooks).sort()).toEqual(HOOK_EVENTS.map(e => e.name).sort())
  })

  test('matcher 가 설치기와 같다', () => {
    for (const e of HOOK_EVENTS) {
      const entry = pluginHooks().hooks[e.name]![0]!
      expect(entry.matcher).toBe(e.matcher as string | undefined)
    }
  })

  test('async 를 달지 않는다', async () => {
    // Codex 는 async 훅을 목록에서 통째로 뺀다 — 파일에는 남아 있는데 한 번도
    // 돌지 않는 고장이라, 눈으로는 안 보인다.
    expect(JSON.stringify(await committed(PLUGIN_HOOKS))).not.toContain('"async"')
  })

  test('상한을 명시한다', () => {
    // 빠지면 Codex 기본값(600초 · 무제한)으로 떨어져, 훅이 메시지 단위로
    // 끊어 둔 예산이 아무 효과가 없어진다.
    for (const entries of Object.values(pluginHooks().hooks)) {
      for (const hook of entries[0]!.hooks) {
        expect(hook.timeout).toBeGreaterThan(0)
        expect(hook.additionalContextLimit).toBeGreaterThan(0)
      }
    }
  })

  test('훅 명령이 이벤트 이름을 싣는다', () => {
    // 훅 런타임은 stdin 이 아니라 `--event` 로 이벤트를 판정한다.
    for (const e of HOOK_EVENTS) {
      const hook = pluginHooks().hooks[e.name]![0]!.hooks[0]!
      expect(hook.command).toBe(`${runnerCommand()} hook --event ${e.name}`)
    }
  })
})

describe('MCP 서버 — 번들에 닿는 길이 에이전트마다 다르다', () => {
  test('Claude 는 인자 안의 변수를 치환한다', () => {
    // 실측: `claude mcp list` 가 절대경로로 풀린 명령을 보여 준다.
    expect(serverOf(claudeManifest(version))).toEqual({
      command: 'bun',
      args: ['${CLAUDE_PLUGIN_ROOT}/dist/acm.js', '--delivery', 'both'],
    })
  })

  test('Codex 는 치환하지 않는다 — cwd 로 푼다', () => {
    // 실측: `${...}` 일곱 형태 전부가 문자 그대로 자식에게 건너가고,
    // 환경변수로도 오지 않는다. 대신 `cwd` 는 플러그인 루트 기준으로 풀린다.
    expect(serverOf(codexManifest(version))).toEqual({
      command: 'bun',
      args: ['dist/acm.js', '--delivery', 'inbox'],
      cwd: '.',
    })
  })

  test('Codex 인자에 변수를 넣지 않는다', () => {
    // 넣으면 오류가 아니라 침묵이다 — 서버가 못 뜨고 툴만 사라진다.
    expect(JSON.stringify(serverOf(codexManifest(version)))).not.toContain('${')
  })

  test('Claude 에는 cwd 를 걸지 않는다', () => {
    // Claude 의 `cwd` 는 플러그인 루트가 아니라 세션 작업 디렉토리 기준이다.
    // `cwd: "."` + 상대 경로로 맞추면 세션을 어디서 여느냐에 따라 갈린다.
    expect(serverOf(claudeManifest(version)).cwd).toBeUndefined()
  })

  test('전달 방식을 생략하지 않는다', () => {
    // 생략하면 어댑터가 뜨지 않는다(§4). 매니페스트는 사람이 고칠 자리가
    // 아니라, 빠진 채 배포되면 설치한 모두가 같은 고장을 겪는다.
    expect(serverOf(claudeManifest(version)).args).toContain('--delivery')
    expect(serverOf(codexManifest(version)).args).toContain('--delivery')
  })

  test('Claude 는 both, Codex 는 inbox', () => {
    // Claude 는 주입이 개발 플래그에 걸려 있어 수신함이 함께 있어야 하고,
    // Codex 는 주입 경로가 아예 없다.
    expect(serverOf(claudeManifest(version)).args.at(-1)).toBe('both')
    expect(serverOf(codexManifest(version)).args.at(-1)).toBe('inbox')
  })
})

describe('마켓플레이스', () => {
  test('Claude·Codex 가 같이 읽는 자리에 있다', () => {
    // Codex 바이너리가 아는 목록 경로도 `.claude-plugin/marketplace.json` 이다.
    expect(MARKETPLACE_MANIFEST).toBe('.claude-plugin/marketplace.json')
  })

  test('플러그인 루트가 레포 루트가 아니다', () => {
    // 레포 루트를 플러그인 루트로 쓰면 개발용 CLAUDE.md 가 배포물에 실린다.
    const m = marketplaceManifest(version) as { plugins: { source: string }[] }
    expect(m.plugins[0]!.source).toBe(`./${PLUGIN_DIR}`)
    expect(PLUGIN_DIR).not.toBe('.')
  })

  test('두 매니페스트와 번들이 같은 플러그인 루트를 쓴다', () => {
    // 한쪽만 옮기면 그 에이전트에서만 조용히 못 찾는다.
    for (const p of [CLAUDE_MANIFEST, CODEX_MANIFEST, PLUGIN_HOOKS, PLUGIN_BUNDLE]) {
      expect(p.startsWith(`${PLUGIN_DIR}/`)).toBe(true)
    }
  })
})
