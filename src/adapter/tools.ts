/**
 * MCP 툴 정의 — 세션 → 메시 방향
 *
 * 설계 근거는 docs/architecture.md §4「어댑터」의 계약 표.
 *
 * 세션에서 메시로 나가는 방향은 **에이전트마다 같다** — MCP 툴 호출이다.
 * 갈리는 것은 반대 방향뿐이므로, 이쪽은 어댑터가 공유한다.
 *
 * 스파이크의 `reply(chat_id, text)` 를 `send(channel_id, text)` 로 바꾼다.
 * `reply` 는 "방금 온 것에 답한다"는 뜻이라 에이전트가 먼저 말을 거는 경우를
 * 표현하지 못했다. 채널은 대화 상대가 아니라 **집합**이므로(§5) 보내는 대상은
 * 채널이지 회신 대상이 아니다.
 */
import type { MeshNode } from '../node/node.js'
import type { Inbox } from './inbox.js'
import { toHex } from '../identity/fingerprint.js'

/** MCP `tools/list` 에 그대로 실을 수 있는 형태. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export const SEND_TOOL: ToolSpec = {
  name: 'send',
  description: '채널에 메시지를 보낸다. channel_id 는 channels 툴로 확인한다.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: '보낼 채널' },
      text: { type: 'string', description: '보낼 내용' },
    },
    required: ['channel_id', 'text'],
  },
}

export const CHANNELS_TOOL: ToolSpec = {
  name: 'channels',
  description: '붙어 있는 채널과 멤버를 보여준다.',
  inputSchema: { type: 'object', properties: {} },
}

/** 수신함 어댑터에서만 노출한다 — 능동 주입이 되는 곳엔 필요 없다. */
export const INBOX_TOOL: ToolSpec = {
  name: 'inbox',
  description: '도착한 메시지를 읽는다. 안 읽은 것만 돌려주며, 읽으면 읽음 표시된다.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: '이 채널만 본다. 생략하면 전부.' },
    },
  },
}

/** 툴 실행 결과. MCP `content` 로 감싸기 직전의 평문. */
export interface ToolResult {
  readonly text: string
  readonly isError?: boolean
}

export interface HandlerContext {
  readonly node: MeshNode
  /** 수신함 어댑터만 준다. 없으면 `inbox` 툴이 동작하지 않는다. */
  readonly inbox?: Inbox
}

/**
 * 툴 호출을 처리한다.
 *
 * 오류를 던지지 않고 `isError` 로 돌려준다 — MCP 툴 오류는 모델이 읽고
 * 고칠 수 있어야 하며, 서브프로세스를 죽일 일이 아니다.
 */
export async function callTool(
  ctx: HandlerContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'send':
        return await handleSend(ctx, args)
      case 'channels':
        return handleChannels(ctx)
      case 'inbox':
        return handleInbox(ctx, args)
      default:
        return { text: `모르는 툴이다: ${name}`, isError: true }
    }
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true }
  }
}

async function handleSend(
  ctx: HandlerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const channelId = str(args.channel_id)
  const text = str(args.text)
  if (!channelId) return { text: 'channel_id 가 필요하다', isError: true }
  if (!text) return { text: 'text 가 필요하다', isError: true }

  const speech = ctx.node.speech(channelId)
  if (!speech) return { text: `붙어 있지 않은 채널이다: ${channelId}`, isError: true }

  // 예산은 발화 제어의 총량 장치다 (§7). 모델이 툴을 직접 부르는 경로도
  // 예외가 아니다 — 여기를 비우면 모델이 예산을 우회한다.
  if (speech.remaining <= 0) {
    return { text: `이 채널의 메시지 예산을 다 썼다 (${speech.used})`, isError: true }
  }

  await ctx.node.send(channelId, text)
  return { text: `보냈다 (남은 예산 ${speech.remaining})` }
}

function handleChannels(ctx: HandlerContext): ToolResult {
  const ids = ctx.node.channelIds()
  if (ids.length === 0) return { text: '붙어 있는 채널이 없다.' }

  const lines = ids.map(id => {
    const channel = ctx.node.channel(id)!
    const members = channel
      .list()
      .map(m => `    ${m.label ?? '(이름 없음)'}  fp ${toHex(m.fingerprint)}`)
      .join('\n')
    const unread = ctx.inbox ? ` · 안 읽음 ${ctx.inbox.unread(id)}` : ''
    return `${channel.name || '(이름 없는 채널)'}\n  id ${id}${unread}\n${members}`
  })
  return { text: lines.join('\n\n') }
}

function handleInbox(ctx: HandlerContext, args: Record<string, unknown>): ToolResult {
  if (!ctx.inbox) return { text: '이 어댑터에는 수신함이 없다', isError: true }

  const channelId = str(args.channel_id)
  const messages = ctx.inbox.take(channelId)
  if (messages.length === 0) return { text: '새 메시지가 없다.' }

  const lines = messages.map(m => {
    const who = m.senderLabel ?? toHex(m.senderKeyId)
    // 발화 판정을 함께 보여준다 — 메시지는 판정과 무관하게 전달되고(§7
    // 「읽되 응답하지 않는다」), 응답 여부는 모델이 이걸 보고 정한다.
    const note = m.decision.speak ? '' : `  [응답 안 함: ${m.decision.reason}]`
    return `<${who}@${m.channelId}>${note}\n${m.text}`
  })
  return { text: lines.join('\n\n') }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
