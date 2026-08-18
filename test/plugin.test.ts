/**
 * 플러그인 산출물이 생성기와 어긋나지 않는지 지킨다.
 *
 * 매니페스트·훅 파일은 **커밋된 파일**이 곧 배포물이라, 생성기를 고치고 다시
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
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  MARKETPLACE_MANIFEST,
  PLUGIN_HOOKS,
  PLUGIN_DIR,
  PACKAGE_NAME,
} from '../src/install/plugin.js'
import { HOOK_EVENTS } from '../src/install/hooks.js'

const pkg = (await Bun.file('package.json').json()) as { version: string; name: string }
const version = pkg.version

async function committed(path: string): Promise<unknown> {
  return await Bun.file(path).json()
}

describe('커밋된 산출물 = 생성 결과', () => {
  const cases: readonly [string, unknown][] = [
    [CLAUDE_MANIFEST, claudeManifest(version)],
    [CODEX_MANIFEST, codexManifest(version)],
    [MARKETPLACE_MANIFEST, marketplaceManifest(version)],
    [PLUGIN_HOOKS, pluginHooks(version)],
  ]

  for (const [path, expected] of cases) {
    test(`${path} 가 최신이다`, async () => {
      // 어긋나면 `bun run plugin` 을 다시 돌려라.
      expect(await committed(path)).toEqual(expected as Record<string, unknown>)
    })
  }
})

describe('패키지 이름·버전', () => {
  test('플러그인 이름이 npm 패키지 이름과 같다', () => {
    expect(pkg.name).toBe(PACKAGE_NAME)
  })

  test('실행 명령에 버전이 박혀 있다', () => {
    // `@latest` 면 어느 날 레지스트리가 바뀌는 것만으로 팀원들의 훅 동작이
    // 갈리고, 그때 누가 무엇을 돌리고 있었는지 되짚을 수 없다.
    expect(runnerCommand(version)).toBe(`bunx ${PACKAGE_NAME}@${version}`)
    expect(runnerCommand(version)).not.toContain('latest')
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
    expect(Object.keys(pluginHooks(version).hooks).sort()).toEqual(
      HOOK_EVENTS.map(e => e.name).sort(),
    )
  })

  test('matcher 가 설치기와 같다', () => {
    for (const e of HOOK_EVENTS) {
      const entry = pluginHooks(version).hooks[e.name]![0]!
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
    for (const entries of Object.values(pluginHooks(version).hooks)) {
      for (const hook of entries[0]!.hooks) {
        expect(hook.timeout).toBeGreaterThan(0)
        expect(hook.additionalContextLimit).toBeGreaterThan(0)
      }
    }
  })

  test('훅 명령이 이벤트 이름을 싣는다', () => {
    // 훅 런타임은 stdin 이 아니라 `--event` 로 이벤트를 판정한다.
    for (const e of HOOK_EVENTS) {
      const hook = pluginHooks(version).hooks[e.name]![0]!.hooks[0]!
      expect(hook.command).toBe(`${runnerCommand(version)} hook --event ${e.name}`)
    }
  })
})

describe('전달 방식', () => {
  const argsOf = (manifest: unknown): readonly string[] =>
    (manifest as { mcpServers: Record<string, { args: string[] }> }).mcpServers[PACKAGE_NAME]!.args

  test('Claude 는 both — 주입이 막혀도 수신함으로 꺼낸다', () => {
    expect(argsOf(claudeManifest(version))).toEqual([
      `${PACKAGE_NAME}@${version}`,
      '--delivery',
      'both',
    ])
  })

  test('Codex 는 inbox — 주입 경로가 없다', () => {
    expect(argsOf(codexManifest(version))).toEqual([
      `${PACKAGE_NAME}@${version}`,
      '--delivery',
      'inbox',
    ])
  })

  test('전달 방식을 생략하지 않는다', () => {
    // 생략하면 어댑터가 뜨지 않는다(§4). 매니페스트는 사람이 고칠 자리가
    // 아니라, 빠진 채 배포되면 설치한 모두가 같은 고장을 겪는다.
    for (const m of [claudeManifest(version), codexManifest(version)]) {
      expect(argsOf(m)).toContain('--delivery')
    }
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

  test('두 매니페스트가 같은 플러그인 루트를 쓴다', () => {
    // 한쪽만 옮기면 그 에이전트에서만 조용히 못 찾는다.
    expect(CLAUDE_MANIFEST.startsWith(`${PLUGIN_DIR}/`)).toBe(true)
    expect(CODEX_MANIFEST.startsWith(`${PLUGIN_DIR}/`)).toBe(true)
    expect(PLUGIN_HOOKS.startsWith(`${PLUGIN_DIR}/`)).toBe(true)
  })
})
