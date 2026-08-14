/**
 * 어댑터 공개 API
 *
 * **코어 배럴(`src/index.ts`)과 따로 둔다.** 코어를 쓰는 쪽이 어댑터를
 * 딸려 받으면 경계가 이름뿐인 것이 된다 — `claude/channel` 은 여기서만
 * 보여야 한다 (CLAUDE.md「코어와 어댑터 경계」).
 *
 * 어댑터를 직접 조립하는 것은 드물다. 대부분은 `serve()` 하나면 된다.
 */

// 두 어댑터가 공유하는 툴 (세션 → 메시)
export {
  callTool,
  SEND_TOOL,
  CHANNELS_TOOL,
  INBOX_TOOL,
  type ToolSpec,
  type ToolResult,
  type HandlerContext,
} from './tools.ts'

// 수신함 — 능동 주입이 없는 에이전트의 전달 방식
export { Inbox, DEFAULT_CAPACITY, type InboxItem, type InboxOptions } from './inbox.ts'

// Claude Code — 능동 주입
export {
  ClaudeAdapter,
  CAPABILITIES,
  INSTRUCTIONS,
  TOOLS,
  type Notify,
  type ClaudeAdapterOptions,
} from './claude.ts'

// 프로세스로 띄우기
export { serve, SERVER_NAME, SERVER_VERSION, type Delivery, type ServeOptions } from './server.ts'

// 설정 — 어댑터는 대화창이 없어서 파일이 유일한 입력이다
export {
  loadConfig,
  buildNode,
  validate,
  fromHex,
  expandHome,
  DEFAULT_CONFIG_PATH,
  type Config,
  type ChannelConfig,
  type MemberConfig,
  type LoadOptions,
} from './config.ts'

// 온보딩 — 손으로 만들 수 없는 값을 만들어 준다
export {
  init,
  whoami,
  skeleton,
  newChannelSecret,
  hex,
  type InitResult,
  type InitOptions,
} from './onboard.ts'

// 실행 진입점
export { main, parseArgs, type Args, type Command } from './bin.ts'
