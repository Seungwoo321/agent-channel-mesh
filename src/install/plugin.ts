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

/** npm 에 올라간 이름. 플러그인은 레포가 아니라 이 패키지를 실행한다. */
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

/** 두 에이전트가 **같이** 읽는 목록. Codex 도 `.codex-plugin/` 이 아니라 여기를 본다. */
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json'

/**
 * 플러그인이 훅·MCP 서버를 띄울 때 쓰는 명령.
 *
 * `${CLAUDE_PLUGIN_ROOT}` 의 소스를 직접 돌리지 않는다 — 플러그인은 클론만
 * 되고 의존성 설치는 일어나지 않아, 그 경로로 부르면 첫 실행에서 모듈을 못 찾고
 * 죽는다. 레지스트리에서 받아 캐시하는 `bunx` 가 설치 단계 없는 유일한 길이다.
 *
 * 버전을 **박는다**. `@latest` 로 두면 어느 날 레지스트리가 바뀌는 것만으로
 * 팀원들의 훅 동작이 갈리고, 그때 누가 무엇을 돌리고 있었는지 되짚을 수 없다.
 */
export function runnerCommand(version: string): string {
  return `bunx ${PACKAGE_NAME}@${version}`
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
 */
export function pluginHooks(version: string): { hooks: HookMap } {
  const runner = runnerCommand(version)
  const hooks: HookMap = {}
  for (const e of HOOK_EVENTS) {
    hooks[e.name] = [
      {
        ...(e.matcher !== undefined ? { matcher: e.matcher } : {}),
        hooks: [
          {
            type: 'command',
            command: `${runner} hook --event ${e.name}`,
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
 */
export function pluginMcp(version: string, delivery: 'both' | 'inbox'): unknown {
  return {
    mcpServers: {
      [PACKAGE_NAME]: {
        command: 'bunx',
        args: [`${PACKAGE_NAME}@${version}`, '--delivery', delivery],
      },
    },
  }
}

const AUTHOR = { name: 'Seungwoo321', url: 'https://github.com/Seungwoo321' }
const REPO = `https://github.com/Seungwoo321/${PACKAGE_NAME}`
const DESCRIPTION = '종단 간 암호화된 코딩 에이전트 메시징 메시 — 다른 사람의 에이전트와 대화한다'
const KEYWORDS = ['mcp', 'e2ee', 'messaging', 'agent']

/**
 * Claude Code 매니페스트.
 *
 * MCP 서버와 훅을 **여기 인라인으로** 둔다. 레포 루트에 `.mcp.json` 을 두면
 * 그 파일은 이 레포에서 여는 모든 세션의 프로젝트 MCP 설정으로도 읽혀,
 * 개발용 세션에 서버가 딸려 붙는다 — 배포 산출물이 개발 환경을 바꾸는 것은
 * 의도가 아니다.
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
    ...(pluginMcp(version, 'both') as object),
    hooks: './hooks/hooks.json',
  }
}

/**
 * Codex 매니페스트.
 *
 * 모양은 Claude 것과 같고 둘만 다르다 — 전달 방식이 `inbox` 이고,
 * Codex 앱 목록에 뜨는 `interface` 블록이 붙는다. 훅은 선언하지 않는다:
 * Codex 는 플러그인 루트의 `hooks/hooks.json` 을 관례로 집는다.
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
    ...(pluginMcp(version, 'inbox') as object),
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

if (import.meta.main) {
  const { version } = (await Bun.file('package.json').json()) as { version: string }
  const write = async (path: string, value: unknown): Promise<void> => {
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
    process.stdout.write(`썼다: ${path}\n`)
  }
  await write(CLAUDE_MANIFEST, claudeManifest(version))
  await write(CODEX_MANIFEST, codexManifest(version))
  await write(MARKETPLACE_MANIFEST, marketplaceManifest(version))
  await write(PLUGIN_HOOKS, pluginHooks(version))
}
