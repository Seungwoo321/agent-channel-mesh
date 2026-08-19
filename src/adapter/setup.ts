/**
 * 설정이 없을 때 뜨는 서버 — 첫 실행이 침묵으로 끝나지 않게 한다
 *
 * 설계 근거는 docs/architecture.md §11「설정」· §11.1「배포」.
 *
 * 플러그인을 막 깐 사람에게 설정 파일은 **없다.** 그런데 어댑터의 유일한
 * 입력이 그 파일이므로(§11), 없으면 서버가 뜨지 못한다. 뜨지 못한 MCP 서버는
 * 에이전트에 따라 "연결 실패" 한 줄이거나 **아무 표시도 없다** — 후자가
 * 기본값이다. 깐 사람은 툴이 왜 없는지 알 길이 없고, 훅도 같은 이유로
 * 조용히 지나간다. 정확히 이 프로젝트가 계속 경계해 온 "동작하는 것처럼
 * 보이는 고장"이라, 첫 실행에는 **말을 하는 서버**가 떠야 한다.
 *
 * 그래서 여기 있는 서버는 메시가 아니다. 신원도 채널도 릴레이도 없고
 * 저장소도 열지 않는다 — 할 수 있는 일은 `setup` 하나뿐이다. 코어를 이
 * 상태에 맞춰 무르게 만들지 않으려고 **서버 자체를 분리했다**: `serve` 는
 * 여전히 온전한 노드를 요구하고, 이 파일은 그 앞에 서 있을 뿐이다.
 *
 * 설정이 생기면 이 서버는 다시 뜨지 않는다.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CONFIGURE_TOOLS, isConfigureTool, runConfigure } from './configure.js'
import { init, whoami, newChannelSecret } from './onboard.js'
import { SERVER_NAME, SERVER_VERSION } from './server.js'
import type { ToolSpec } from './tools.js'

/**
 * 설정을 만드는 툴.
 *
 * 사람이 경로를 찾아 CLI 를 치는 길도 남아 있지만(`bun <번들> init`),
 * 플러그인의 설치 위치는 에이전트·마켓플레이스·버전에 따라 갈리는 캐시
 * 경로라 **받아 적을 수 있는 명령이 아니다.** 세션 안에서 부를 수 있는
 * 툴이 있으면 그 경로를 아무도 알 필요가 없다.
 */
export const SETUP_TOOL: ToolSpec = {
  name: 'setup',
  description:
    '메시 설정을 만든다. 아직 신원이 없을 때 한 번만 부른다. ' +
    '시드를 새로 만들어 0600 으로 저장하고, 상대에게 보낼 공개키와 지문을 돌려준다.',
  inputSchema: {
    type: 'object',
    properties: {
      relay: {
        type: 'string',
        description: '릴레이 base URL. 사용자에게 받는다 — 추측하지 않는다.',
      },
      label: {
        type: 'string',
        description: '상대 설정에 적힐 내 이름. 신뢰의 근거가 아니라 표시용이다.',
      },
    },
  },
}

/**
 * 모델에게 하는 말.
 *
 * 릴레이 URL 을 **추측하지 말라고 못 박는다.** 틀린 릴레이가 박히면 설정은
 * 멀쩡히 만들어지고 메시지만 영원히 안 간다 — 되돌리려면 파일을 손으로
 * 고쳐야 하는데, 그때쯤이면 아무도 그 값이 추측이었다는 것을 모른다.
 */
export const SETUP_INSTRUCTIONS =
  'agent-channel-mesh is installed but has no identity yet, so no messaging tools are available. ' +
  'Tell the user this once, then ask them for the relay URL and the name they want to be known by. ' +
  'Do not guess the relay URL — a wrong one configures cleanly and then silently delivers nothing. ' +
  'Call the setup tool with those values, show the user everything it returns, ' +
  'and tell them to restart this session so the mesh tools load.'

export interface SetupOptions {
  /** 설정을 만들 경로. 이미 있으면 만들지 않는다. */
  readonly configPath: string
  /** 릴레이 쓰기 토큰 (§10.13). 환경변수에서만 온다. */
  readonly relayToken?: string
}

/**
 * 설정을 만들고, 사람이 다음에 할 일을 돌려준다.
 *
 * 채널 비밀을 **여기서 같이 만들어 준다.** 설정을 만든 직후에 필요한 값이
 * 정확히 그것 하나이고(§10.11), 32바이트 hex 를 사람이 만들 수단은 없다.
 * 시드는 돌려주지 않는다 — `whoami` 는 공개키와 지문만 낸다.
 */
export async function runSetup(
  options: SetupOptions,
  args: { relay?: string; label?: string } = {},
): Promise<{ text: string; isError: boolean }> {
  const { path, identity, existed } = await init(options.configPath, {
    ...(args.relay !== undefined ? { relay: args.relay } : {}),
    ...(options.relayToken !== undefined ? { relayToken: options.relayToken } : {}),
  })

  if (existed) {
    // 덮어쓰지 않는 것이 `init` 의 계약이다(§onboard). 여기서 "성공"이라고
    // 하면 모델이 새 신원이 생겼다고 믿고 상대에게 옛 지문을 보낸다.
    return {
      text:
        `설정이 이미 있다: ${path}\n` +
        '아무것도 바꾸지 않았다 — 시드를 덮어쓰면 신원을 잃고, ' +
        '상대가 대조해 둔 지문이 전부 무효가 된다.\n' +
        '이 세션에 메시 툴이 없다면 설정이 없어서가 아니다. ' +
        '세션을 다시 열고, 그래도 없으면 이 파일의 권한(600)과 내용을 확인한다.',
      isError: true,
    }
  }

  return {
    text: [
      `설정을 만들었다: ${path} (0600)`,
      '',
      whoami(identity, args.label),
      '',
      '채널을 여는 쪽이 이 비밀을 만들어 멤버에게 대역 외로 전달한다:',
      '',
      `  ${newChannelSecret()}`,
      '',
      '다음 순서로 진행한다.',
      '  1. 위 members 값과 지문을 상대에게 보낸다. 지문은 다른 경로로 대조한다.',
      '  2. 상대의 값을 받아 설정 파일의 channels 에 서로를 넣는다.',
      '  3. 세션을 다시 연다 — 그때 메시 툴이 뜬다.',
    ].join('\n'),
    isError: false,
  }
}

/**
 * 설정 만들기만 할 줄 아는 stdio MCP 서버를 띄운다.
 *
 * 돌려주는 모양이 `serve` 와 같아서 진입점이 둘을 구분하지 않아도 된다.
 */
export async function serveSetup(options: SetupOptions): Promise<{ stop: () => Promise<void> }> {
  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // 능동 주입을 선언하지 않는다 — 주입할 노드가 아직 없다.
    { capabilities: { tools: {} }, instructions: SETUP_INSTRUCTIONS },
  )

  // 설정을 고치는 툴도 함께 낸다. 신원을 만든 **직후에** 하는 일이 채널
  // 합류이고, 그것을 다음 세션으로 미루면 사람이 한 번 더 왕복해야 한다 —
  // 여기서 채널까지 넣고 나서 한 번만 다시 열면 된다.
  //
  // 오염 검사는 걸지 않는다. 저장소가 아직 없어 오염을 둘 자리가 없고,
  // 신원이 없으면 도착한 말도 없어 오염될 수단 자체가 없다 (§8.3).
  const tools = [SETUP_TOOL, ...CONFIGURE_TOOLS]

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    if (isConfigureTool(req.params.name)) {
      const changed = await runConfigure(
        { configPath: options.configPath },
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      )
      return { content: [{ type: 'text', text: changed.text }], isError: changed.isError }
    }
    if (req.params.name !== SETUP_TOOL.name) {
      return {
        content: [{ type: 'text', text: `모르는 툴: ${req.params.name}` }],
        isError: true,
      }
    }
    const args = (req.params.arguments ?? {}) as { relay?: string; label?: string }
    const result = await runSetup(options, args)
    return { content: [{ type: 'text', text: result.text }], isError: result.isError }
  })

  await mcp.connect(new StdioServerTransport())

  return { stop: async () => await mcp.close() }
}
