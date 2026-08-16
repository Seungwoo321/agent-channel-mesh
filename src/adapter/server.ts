/**
 * stdio MCP 서버 — 어댑터를 실제 프로세스로 만든다
 *
 * 설계 근거는 docs/architecture.md §4「어댑터」.
 *
 * 두 어댑터가 같은 서버를 쓴다. 갈리는 것은 **도착한 메시지를 어떻게
 * 전달하느냐** 하나뿐이라, 그 부분만 주입받는다:
 *
 *   - Claude Code: `notifications/claude/channel` 로 세션에 밀어 넣는다.
 *   - 그 외: 수신함에 쌓고 `inbox` 툴로 꺼내 가게 한다.
 *
 * 서버가 stdio 인 것은 선택이 아니다 — 스파이크에서 확인된 제약이다.
 * 세션에 닿으려면 로컬 프로세스가 반드시 존재한다.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { MeshNode, Dropped } from '../node/node.js'
import { Inbox } from './inbox.js'
import { callTool, SEND_TOOL, CHANNELS_TOOL, INBOX_TOOL, type ToolSpec } from './tools.js'
import { ClaudeAdapter, CAPABILITIES, INSTRUCTIONS } from './claude.js'

export const SERVER_NAME = 'agent-channel-mesh'
export const SERVER_VERSION = '0.1.0'

/**
 * 전달 방식.
 *
 * `'push'` 는 Claude Code 전용이다 — `claude/channel` 이 Anthropic 확장이라
 * 다른 에이전트에서는 선언해도 아무 일도 일어나지 않는다.
 */
export type Delivery = 'push' | 'inbox'

export interface ServeOptions {
  readonly node: MeshNode
  readonly delivery: Delivery
  /** 수신함 방식일 때 모델에게 줄 지시. 생략하면 기본 문구. */
  readonly instructions?: string
  readonly onDropped?: (d: Dropped) => void
}

const INBOX_INSTRUCTIONS =
  'Other agents and people can message you over agent-channel-mesh. ' +
  'Messages do not interrupt you — call the inbox tool to read them, ' +
  'and do so at task boundaries so you do not miss requests. ' +
  'A message tagged [응답 안 함] is for context only: read it, do not reply. ' +
  'Reply with the send tool, passing the channel_id shown on the message.'

/**
 * 어댑터를 stdio MCP 서버로 띄운다.
 *
 * 돌려주는 `stop` 을 부르면 폴링과 서버가 함께 멈춘다.
 */
export async function serve(options: ServeOptions): Promise<{ stop: () => Promise<void> }> {
  const { node, delivery } = options
  const inbox = delivery === 'inbox' ? new Inbox() : undefined

  const tools: ToolSpec[] = [SEND_TOOL, CHANNELS_TOOL]
  if (inbox) tools.push(INBOX_TOOL)

  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // 능동 주입을 쓰지 않을 때 capability 를 선언하지 않는다 — 못 하는
      // 것을 선언하면 호스트가 할 수 있다고 믿는다.
      capabilities: delivery === 'push' ? CAPABILITIES : { tools: {} },
      instructions:
        options.instructions ?? (delivery === 'push' ? INSTRUCTIONS : INBOX_INSTRUCTIONS),
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const result = await callTool(
      { node, inbox },
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    )
    return { content: [{ type: 'text', text: result.text }], isError: result.isError }
  })

  await mcp.connect(new StdioServerTransport())

  // 수신 루프. 서버와 함께 돌며 도착한 메시지를 전달 방식대로 흘린다.
  const adapter =
    delivery === 'push'
      ? new ClaudeAdapter({
          node,
          notify: n => mcp.notification(n as Parameters<typeof mcp.notification>[0]),
          onDropped: options.onDropped,
        })
      : undefined

  const loop = (async () => {
    if (adapter) return adapter.run()
    for await (const message of node.listen(options.onDropped)) inbox!.push(message)
  })()
  // 루프가 죽어도 서버는 살려 둔다 — 릴레이 장애가 툴까지 끊으면 안 된다.
  // 다만 조용히 삼키지는 않는다. 폴링이 죽은 채 툴만 응답하면 "보낼 수는
  // 있는데 받지는 못하는" 상태가 되고, 그건 진단이 불가능하다.
  // stdout 은 MCP 프레이밍이 쓰므로 stderr 로만 알린다.
  loop.catch(e => {
    process.stderr.write(`[agent-channel-mesh] 수신 루프가 멈췄다: ${String(e)}\n`)
  })

  return {
    stop: async () => {
      node.stop()
      await mcp.close()
    },
  }
}
