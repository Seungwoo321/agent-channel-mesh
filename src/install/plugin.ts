/**
 * 플러그인 산출물 생성 — Claude Code 와 Codex 가 같은 레포를 읽는다 (§6.6)
 *
 * 두 에이전트가 **같은 마켓플레이스 파일**을 읽는다. Codex 바이너리가 아는
 * 경로는 `.claude-plugin/marketplace.json` · `.claude-plugin/plugin.json` ·
 * `.codex-plugin/plugin.json` 셋이고, 목록은 Claude 것을 그대로 쓰며 플러그인
 * 매니페스트만 자기 것을 먼저 본다. 그래서 레포 하나 · 목록 하나 · 훅 하나에
 * 매니페스트만 둘이면 양쪽이 같은 등급으로 선다.
 *
 * 플러그인은 **배포 형태**이지 두 번째 구현이 아니다. 훅 목록은 설치기와 같은
 * `HOOK_EVENTS` 한 곳에서 나오고, 여기서는 그것을 플러그인이 읽는 파일 모양으로
 * 옮겨 적기만 한다. 손으로 적어 두면 이벤트를 하나 추가했을 때 설치기로 깐
 * 사람에게만 알림이 오고 플러그인으로 깐 사람에게는 안 오는, **설치 경로마다
 * 동작이 갈리는** 고장이 난다.
 *
 * 커밋된 파일이 이 생성 결과와 같은지는 테스트가 지킨다.
 */
import {
  HOOK_EVENTS,
  CODEX_TIMEOUT_SEC,
  CODEX_CONTEXT_LIMIT,
  type HookMap,
} from './hooks.js'
import { CODEX_CONFIG_PATH } from '../adapter/config.js'

/** 플러그인·패키지·MCP 서버가 공유하는 이름. */
export const PACKAGE_NAME = 'agent-channel-mesh'

/**
 * 플러그인 루트를 레포 루트로 두지 않는다.
 *
 * 플러그인 루트의 `CLAUDE.md`·`CLAUDE.local.md` 는 플러그인 컨텍스트로 실리지
 * 않는데, 레포 루트를 그대로 쓰면 개발용 문서가 배포물에 딸려 들어가 검증에
 * 걸린다. 껍데기 디렉토리를 따로 두면 배포되는 것이 매니페스트와 훅뿐임이
 * 파일 구조로 드러난다.
 */
export const PLUGIN_DIR = 'plugin'
export const CLAUDE_MANIFEST = `${PLUGIN_DIR}/.claude-plugin/plugin.json`
export const CODEX_MANIFEST = `${PLUGIN_DIR}/.codex-plugin/plugin.json`
export const PLUGIN_HOOKS = `${PLUGIN_DIR}/hooks/hooks.json`

/**
 * 스킬 디렉토리. 두 로더가 관례로 집는 자리다 — 매니페스트에 적지 않는다
 * ({@link claudeManifest}).
 *
 * 매니페스트·훅과 달리 **스킬 본문은 여기서 생성하지 않는다** — 산문이라
 * 코드에서 파생되는 값이 없고, 문자열 리터럴에 가둬 두면 고치는 사람이
 * 마크다운 대신 TypeScript 를 편집하게 된다. 대신 드리프트가 실제로 나는
 * 자리(프론트매터 형식, 스킬이 부르라고 적어 둔 툴 이름, 설정 경로)를
 * `test/plugin.test.ts` 가 코드와 대조한다.
 */
export const PLUGIN_SKILLS = `${PLUGIN_DIR}/skills`
export const SETUP_SKILL = `${PLUGIN_SKILLS}/mesh-setup/SKILL.md`
export const USAGE_SKILL = `${PLUGIN_SKILLS}/mesh-usage/SKILL.md`

/**
 * 실려야 하는 스킬 전부.
 *
 * 둘로 나눈 것은 읽는 시점이 다르기 때문이다 — 셋업은 한 번 붙일 때, 사용법은
 * 붙은 뒤 매번이다. 한 파일에 합치면 매번 읽는 쪽이 다시 볼 일 없는 절차를
 * 함께 지고 가고, 모델이 설정 절차를 사용 중에 다시 밟는다.
 */
export const PLUGIN_SKILL_FILES: readonly string[] = [SETUP_SKILL, USAGE_SKILL]

/** 두 에이전트가 **같이** 읽는 목록. Codex 도 `.codex-plugin/` 이 아니라 여기를 본다. */
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json'

/** 어댑터 번들 진입점 — 이 파일 하나를 묶어 `PLUGIN_BUNDLE` 로 낸다. */
export const BUNDLE_ENTRY = 'src/adapter/bin.ts'

/** 릴레이 번들 진입점. 어댑터와 **같은 이유로** 묶는다 ({@link PLUGIN_RELAY}). */
export const RELAY_ENTRY = 'src/server.ts'

/**
 * 플러그인이 실제로 실행하는 파일. 의존성이 안에 들어간 단일 파일이다.
 *
 * 플러그인은 **클론만 되고 `bun install` 이 일어나지 않는다.** 그래서 소스를
 * 그대로 부르면 첫 import 에서 모듈을 못 찾고 죽는다. 남는 길은 둘인데,
 * 레지스트리에서 받아 오는 것(`bunx <패키지>@<버전>`)과 의존성을 미리 묶어
 * 두는 것이다. 후자를 쓴다 — 전자는 **핀이 둘로 갈린다.** 마켓플레이스는
 * git ref 로 파일을 주는데 실행되는 코드는 npm 버전에서 오므로, 둘이 어긋나면
 * "매니페스트가 선언한 것과 다른 코드가 도는" 상태가 되고 그것을 막을 장치가
 * 설치 쪽에 없다. 번들이면 클론한 것이 곧 도는 것이라 핀이 하나다.
 */
export const PLUGIN_BUNDLE = `${PLUGIN_DIR}/dist/acm.js`

/**
 * 릴레이도 플러그인 안에서 돈다.
 *
 * 로컬 릴레이는 **한 기계 안의 내 에이전트들**(클로드 ↔ 코덱스)이 만나는
 * 자리다. 그것을 쓰려고 사용자가 레포를 따로 클론하게 하지 않는다 — 플러그인을
 * 깔았다는 것이 곧 릴레이를 가졌다는 뜻이어야 한다.
 *
 * 마켓플레이스가 받아 둔 `src/server.ts` 를 그대로 부르지 않는 이유는 둘이다.
 * 그 클론에는 `node_modules` 가 없어 릴레이 그래프의 `@noble/hashes` 에서
 * 죽고, Claude 가 실제로 실행하는 자리는 클론이 아니라 `plugin/` 만 복사해 둔
 * 캐시라 두 에이전트가 서로 다른 경로를 타게 된다. 번들이면 양쪽 다 자기
 * 플러그인 루트 안의 같은 파일을 돌린다.
 */
export const PLUGIN_RELAY = `${PLUGIN_DIR}/dist/relay.js`

/** 플러그인 루트 안에서의 번들 위치. 두 에이전트가 서로 다른 방법으로 여기에 닿는다. */
const BUNDLE_REL = 'dist/acm.js'

/**
 * 훅 명령에서 플러그인 루트를 찾는다. Codex는 `PLUGIN_ROOT`, Claude는
 * `CLAUDE_PLUGIN_ROOT`를 제공하므로 셸에서 런타임별로 선택한다. 둘 다 없는
 * 직접 실행은 훅을 통과시키되, 에이전트 세션을 깨뜨리지 않는다.
 */
export function runnerCommand(): string {
  return [
    'if [ -n "${PLUGIN_ROOT:-}" ]; then root="$PLUGIN_ROOT"; agent=codex; config=\'~/.agent-channel-mesh/codex.json\';',
    'elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then root="$CLAUDE_PLUGIN_ROOT"; agent=claude; config=\'~/.agent-channel-mesh/config.json\';',
    "else printf '{}'; exit 0; fi;",
    `exec env ACM_CONFIG="\${ACM_CONFIG:-$config}" bun "$root/${BUNDLE_REL}"`,
  ].join(' ')
}

/**
 * 플러그인 `hooks/hooks.json` — **두 에이전트가 같이 읽는 한 파일**이다.
 *
 * Codex 쪽 조정값(`timeout` · `additionalContextLimit`)을 그대로 싣는다.
 * Claude 는 `timeout` 을 같은 뜻(초)으로 읽고 모르는 키는 넘긴다. 반대로
 * Codex 에서 이 값이 빠지면 상한이 기본값(600초 · 무제한)으로 떨어져,
 * 훅이 메시지 단위로 끊어 둔 예산이 아무 효과가 없어진다.
 *
 * `async` 는 절대 넣지 않는다 — Codex 가 async 훅을 목록에서 빼 버린다.
 * 근거는 `src/install/hooks.ts` 의 {@link codexHooks} 주석에 있다.
 * 명령에 에이전트를 고정하지 않는 이유는 이 파일을 Claude와 Codex가 함께
 * 읽기 때문이다. Codex가 제공하는 `PLUGIN_ROOT`를 번들 런타임이 감지한다.
 */
export function pluginHooks(): { hooks: HookMap } {
  const runner = runnerCommand()
  const hooks: HookMap = {}
  for (const e of HOOK_EVENTS) {
    hooks[e.name] = [
      {
        ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
        hooks: [
          {
            type: 'command',
            command: `${runner} hook --event ${e.name} --agent "$agent"`,
            timeout: CODEX_TIMEOUT_SEC,
            additionalContextLimit: CODEX_CONTEXT_LIMIT,
          },
        ],
      },
    ]
  }
  return { hooks }
}

/**
 * MCP 서버 선언. **전달 방식이 에이전트마다 다르다.**
 *
 * Claude 는 `both` — 세션 주입(§4)과 수신함을 겸한다. 주입이 개발 플래그에
 * 걸린 실험 기능이라, 그것이 막혔을 때 꺼내 갈 경로가 함께 있어야 통째로
 * 막히지 않는다.
 *
 * Codex 는 `inbox` — 주입 경로가 아예 없다. 거기서 `push` 를 켜면 아무도
 * 구현하지 않는 capability 를 선언하는 셈이라, 알림은 훅이 맡고 본문은
 * `inbox` 툴로 꺼낸다.
 *
 * **번들을 가리키는 방법도 갈린다.** 인자는 셸을 거치지 않으므로 두 에이전트
 * 각각이 무엇을 해석해 주느냐로 정해지는데, 실측하면 정반대다.
 *
 * - Claude 는 인자 안의 `${CLAUDE_PLUGIN_ROOT}` 를 절대경로로 치환한다.
 * - Codex 는 **아무것도 치환하지 않고 환경변수로도 주지 않는다.** `${...}`
 *   형태 일곱 가지를 전부 넣어 봐도 문자 그대로 자식에게 건너간다. 대신
 *   `cwd` 를 플러그인 루트 기준으로 풀어 주므로, `cwd: "."` + 상대 경로가
 *   Codex 에서 번들에 닿는 유일한 길이다.
 *
 * 반대로 붙이면 어느 쪽도 오류를 내지 않는다 — MCP 서버가 조용히 못 뜨고,
 * 툴만 없는 상태가 된다. 그래서 모양을 하나로 합치지 않는다.
 */
export function pluginMcp(agent: 'claude' | 'codex'): unknown {
  const server =
    agent === 'claude'
      ? {
          command: 'bun',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/acm.js', '--delivery', 'both'],
        }
      : {
          command: 'bun',
          args: [BUNDLE_REL, '--delivery', 'inbox', '--config', CODEX_CONFIG_PATH],
          cwd: '.',
        }
  return { mcpServers: { [PACKAGE_NAME]: server } }
}

const AUTHOR = { name: 'Seungwoo321', url: 'https://github.com/Seungwoo321' }
const REPO = `https://github.com/Seungwoo321/${PACKAGE_NAME}`
const DESCRIPTION = '종단 간 암호화된 코딩 에이전트 메시징 메시 — 다른 사람의 에이전트와 대화한다'
const KEYWORDS = ['mcp', 'e2ee', 'messaging', 'agent']

/**
 * Claude Code 매니페스트.
 *
 * MCP 서버를 **여기 인라인으로** 둔다. 레포 루트에 `.mcp.json` 을 두면
 * 그 파일은 이 레포에서 여는 모든 세션의 프로젝트 MCP 설정으로도 읽혀,
 * 개발용 세션에 서버가 딸려 붙는다 — 배포 산출물이 개발 환경을 바꾸는 것은
 * 의도가 아니다.
 *
 * **훅과 스킬은 선언하지 않는다.** 두 로더 모두 플러그인 루트의
 * `hooks/hooks.json` 과 `skills/` 를 관례로 집는다(실측). 게다가 Claude 는
 * `hooks` 를 적으면 같은 파일을 두 번 읽고 **플러그인 전체를 못 싣는다** —
 * `Duplicate hooks file detected`. 이것이 "동작하는 것처럼 보이는 고장"인 이유는
 * 드러나는 자리가 하나뿐이라서다: `plugin validate --strict` 는 통과하고,
 * `plugin details` 는 훅·스킬 개수를 그대로 세어 보여주고, `mcp list` 는
 * `✔ Connected` 다. `claude plugin list` 만 `✘ failed to load` 라고 말한다.
 */
export function claudeManifest(version: string): unknown {
  return {
    name: PACKAGE_NAME,
    description: DESCRIPTION,
    version,
    author: AUTHOR,
    homepage: `${REPO}#readme`,
    repository: REPO,
    license: 'Apache-2.0',
    keywords: KEYWORDS,
    ...(pluginMcp('claude') as object),
  }
}

/**
 * Codex 매니페스트.
 *
 * 모양은 Claude 것과 같고 둘만 다르다 — 전달 방식이 `inbox` 이고,
 * Codex 앱 목록에 뜨는 `interface` 블록이 붙는다. 훅·스킬을 선언하지 않는
 * 이유는 {@link claudeManifest} 와 같다.
 */
export function codexManifest(version: string): unknown {
  return {
    name: PACKAGE_NAME,
    description: DESCRIPTION,
    version,
    author: AUTHOR,
    homepage: `${REPO}#readme`,
    repository: REPO,
    license: 'Apache-2.0',
    keywords: KEYWORDS,
    ...(pluginMcp('codex') as object),
    interface: {
      displayName: 'Agent Channel Mesh',
      shortDescription: '다른 사람의 에이전트와 종단 간 암호화로 대화한다.',
      longDescription:
        '릴레이는 봉투만 나르고 본문은 참여자만 연다. 도착한 메시지는 훅이 세션에 알리고, ' +
        '본문은 inbox 툴로 읽는다. 상대를 믿는 근거는 이름이 아니라 지문이다.',
      developerName: AUTHOR.name,
      category: 'Productivity',
      capabilities: ['MCP', 'Hooks'],
      defaultPrompt: [
        '메시 채널에 누가 있는지 보여줘.',
        '수신함에 온 메시지를 읽어줘.',
        '팀원에게 지금 상황을 전해줘.',
      ],
    },
  }
}

/**
 * 이 레포를 마켓플레이스로 쓰기 위한 목록.
 *
 * Claude 와 Codex 가 **같이** 읽는다. `source` 는 레포 안의 상대 경로다 —
 * 양쪽 다 이 레포를 통째로 받은 뒤 그 하위를 플러그인 루트로 삼는다.
 */
export function marketplaceManifest(version: string): unknown {
  return {
    name: PACKAGE_NAME,
    description: `${DESCRIPTION} (Claude Code · Codex)`,
    owner: AUTHOR,
    plugins: [
      {
        name: PACKAGE_NAME,
        source: `./${PLUGIN_DIR}`,
        description: DESCRIPTION,
        version,
        license: 'Apache-2.0',
        homepage: `${REPO}#readme`,
        category: 'productivity',
        tags: KEYWORDS,
      },
    ],
  }
}

/**
 * 번들을 만든다. **압축하지 않는다** — 남의 기계에서 도는 암호 코드라,
 * 읽어서 확인할 수 있다는 것이 크기보다 중요하다.
 *
 * 출력이 결정적이라 커밋된 번들과 여기서 나온 것이 바이트 단위로 같아야
 * 한다. 그 대조는 테스트가 한다.
 */
async function bundle(entry: string, out: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
  })
  if (!built.success) throw new AggregateError(built.logs, `번들 빌드 실패: ${entry}`)
  const [artifact] = built.outputs
  if (artifact === undefined || built.outputs.length !== 1) {
    throw new Error(`번들이 파일 하나로 안 나왔다: ${built.outputs.length}개`)
  }
  await Bun.write(out, artifact)
}

/** 어댑터 번들. 플러그인이 MCP 서버와 훅으로 돌리는 파일이다. */
export async function buildBundle(): Promise<void> {
  await bundle(BUNDLE_ENTRY, PLUGIN_BUNDLE)
}

/** 릴레이 번들. `relay_check` 가 내는 명령이 가리키는 파일이다. */
export async function buildRelay(): Promise<void> {
  await bundle(RELAY_ENTRY, PLUGIN_RELAY)
}

if (import.meta.main) {
  const { version } = (await Bun.file('package.json').json()) as { version: string }
  const write = async (path: string, value: unknown): Promise<void> => {
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
    process.stdout.write(`썼다: ${path}\n`)
  }
  await write(CLAUDE_MANIFEST, claudeManifest(version))
  await write(CODEX_MANIFEST, codexManifest(version))
  await write(MARKETPLACE_MANIFEST, marketplaceManifest(version))
  await write(PLUGIN_HOOKS, pluginHooks())
  await buildBundle()
  process.stdout.write(`썼다: ${PLUGIN_BUNDLE}\n`)
  await buildRelay()
  process.stdout.write(`썼다: ${PLUGIN_RELAY}\n`)
}
