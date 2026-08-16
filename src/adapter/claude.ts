/**
 * Claude Code 어댑터 — 능동 주입
 *
 * 설계 근거는 docs/architecture.md §4「Claude Code 어댑터」.
 *
 * **`claude/channel` 이 존재해도 되는 유일한 파일이다.** 코어는 이 이름을
 * 모른다 (CLAUDE.md「코어와 어댑터 경계」). 여기가 하는 일은 하나다 —
 * 코어가 "메시지가 도착했다"고 알려 주면 그것을 세션에 밀어 넣는다.
 *
 * 스파이크(spike/channel.ts)로 4/4 검증된 프로토콜을 그대로 쓴다:
 *   - `experimental: { 'claude/channel': {} }` 로 채널 등록
 *   - `notifications/claude/channel` 로 인바운드 주입
 *   - 툴 호출로 아웃바운드
 *
 * 제약도 스파이크에서 확인됐다 — 채널은 stdio 서브프로세스다. 순수
 * 서버리스만으로는 세션에 닿을 수 없고, 로컬 프로세스가 반드시 존재한다.
 */
import type { MeshNode, Inbound, Dropped } from '../node/node.js'
import { SEND_TOOL, CHANNELS_TOOL, callTool, type ToolSpec } from './tools.js'

/**
 * 세션에 알림을 보내는 함수.
 *
 * MCP SDK 의 `Server#notification` 을 그대로 받는 모양이다. SDK 를 직접
 * import 하지 않는 이유: 이 모듈을 SDK 없이 테스트할 수 있어야 하고,
 * 어댑터가 전송 계층에 묶이면 그것도 결국 재작성이 된다.
 */
export type Notify = (notification: {
  method: string
  params: Record<string, unknown>
}) => Promise<void>

export interface ClaudeAdapterOptions {
  readonly node: MeshNode
  readonly notify: Notify
  /** 버려진 봉투를 알린다. 없으면 조용히 버린다 (§8). */
  readonly onDropped?: (d: Dropped) => void
}

/**
 * 모델에게 주는 지시.
 *
 * 채널 메시지가 `<channel source="..." chat_id="...">` 로 도착한다는 것과,
 * 답할 때 무엇을 써야 하는지를 알려 준다. 이 문자열이 없으면 모델은 도착한
 * 태그를 사용자 발화로 오해한다.
 */
export const INSTRUCTIONS =
  'Messages from other agents and people arrive as ' +
  '<channel source="agent-channel-mesh" chat_id="...">. ' +
  'The chat_id is the channel id — pass it to the send tool to reply. ' +
  'A message tagged [응답 안 함] is for context only: read it, do not reply. ' +
  'Do not reply to your own messages.'

export const TOOLS: readonly ToolSpec[] = [SEND_TOOL, CHANNELS_TOOL]

/** MCP 서버 생성 시 그대로 넘길 capability 선언. */
export const CAPABILITIES = {
  experimental: { 'claude/channel': {} },
  tools: {},
} as const

/**
 * Claude Code 어댑터.
 *
 * 수신함이 없다 — 밀어 넣을 수 있으므로 쌓아 둘 이유가 없다. 그것이
 * 수신함 어댑터와 갈리는 유일한 지점이다.
 */
export class ClaudeAdapter {
  private readonly node: MeshNode
  private readonly notify: Notify
  private readonly onDropped?: (d: Dropped) => void

  constructor(options: ClaudeAdapterOptions) {
    this.node = options.node
    this.notify = options.notify
    this.onDropped = options.onDropped
  }

  /** `tools/call` 을 그대로 넘긴다. */
  async call(name: string, args: Record<string, unknown>) {
    return callTool({ node: this.node }, name, args)
  }

  /**
   * 메시지 하나를 세션에 주입한다.
   *
   * `meta` 키는 `[A-Za-z0-9_]` 만 유효하다 — **하이픈은 조용히 삭제된다**
   * (CLAUDE.md「채널 프로토콜」). 그래서 `chat_id` 이지 `chat-id` 가 아니다.
   */
  async inject(message: Inbound): Promise<void> {
    await this.notify({
      method: 'notifications/claude/channel',
      params: {
        content: this.render(message),
        meta: {
          chat_id: message.channelId,
          sender: message.senderLabel ?? hex(message.senderKeyId),
        },
      },
    })
  }

  /**
   * 코어의 수신 루프를 돌며 도착한 메시지를 주입한다.
   *
   * 발화 판정과 무관하게 **전부 주입한다** — "읽되 응답하지 않는다"가
   * 멘션 규칙의 정의이고(§7), 읽히지 않으면 그건 필터링이지 발화 제어가
   * 아니다. 응답 여부는 렌더에 실린 표시를 보고 모델이 정한다.
   */
  async run(): Promise<void> {
    for await (const message of this.node.listen(this.onDropped)) {
      await this.inject(message)
    }
  }

  stop(): void {
    this.node.stop()
  }

  private render(m: Inbound): string {
    const who = m.senderLabel ?? hex(m.senderKeyId)
    const note = m.decision.speak ? '' : ` [응답 안 함: ${m.decision.reason}]`
    return `<${who}>${note}\n${m.text}`
  }
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
