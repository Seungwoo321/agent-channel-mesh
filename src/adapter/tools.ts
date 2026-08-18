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
import type { MessageStore, StoredMessage } from '../store/store.js'
import { toHex } from '../identity/fingerprint.js'
import { renderBundle } from './bundle.js'
import { whoami } from './onboard.js'
import { addTaint } from '../policy/taint.js'

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

/**
 * `inbox` 가 채널당 돌려주는 기본 건수.
 *
 * 저장소는 보관 기한 안의 전부를 들고 있으므로(§6.3) 상한이 없으면 며칠치
 * 대화 전문이 한 툴 응답에 실린다 — §6 이 막으려는 비용 문제 그대로다.
 * 최신 쪽을 남긴다(`MessageStore#read`).
 */
export const INBOX_LIMIT = 50

/**
 * 도착한 메시지를 꺼내 간다.
 *
 * **릴레이가 아니라 로컬 저장소를 읽는다**(§4). 큐는 드레인하면 사라지므로
 * 여기서도 릴레이를 치면 주입 경로와 서로의 메시지를 훔친다. 이미 주입된
 * 것도 여기서 다시 보이는 이유가 그것이다 — 주입은 알림이고 정본은 저장소다.
 */
export const INBOX_TOOL: ToolSpec = {
  name: 'inbox',
  description:
    '도착한 메시지를 로컬 저장소에서 읽는다. 이미 세션에 주입된 것도 함께 보이며, ' +
    '아직 전달되지 않은 것에는 [새 메시지] 표시가 붙는다.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: '이 채널만 본다. 생략하면 전부.' },
      limit: {
        type: 'integer',
        minimum: 1,
        description: `채널당 최근 몇 건까지 볼지. 생략하면 ${INBOX_LIMIT}.`,
      },
    },
  },
}

/**
 * 내 공개키와 지문 (§9).
 *
 * 어댑터는 대화창이 없는 서브프로세스라 이 값을 stderr 로만 낸다 — 사람은
 * 그 화면을 보지 못한다. 플러그인으로 깐 사람이 상대에게 보낼 `members`
 * 블록을 꺼낼 자리가 세션 안에 없으면, 3단계(공개키 교환)가 시작조차 되지
 * 않는다. 공개값만 낸다 — 시드는 여기로 나가지 않는다.
 */
export const WHOAMI_TOOL: ToolSpec = {
  name: 'whoami',
  description:
    '상대 설정의 members 에 넣을 내 공개키와, 대역 외로 대조할 내 지문을 보여준다. ' +
    '개인키는 나오지 않는다.',
  inputSchema: {
    type: 'object',
    properties: {
      label: { type: 'string', description: '상대 설정에 적힐 내 이름. 표시용이다.' },
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
  /**
   * 정본 저장소 (§6.3). 툴은 릴레이를 치지 않고 항상 이것만 읽고 쓴다.
   *
   * 주입 전용 어댑터에도 있다 — 나가는 메시지 기록과 안 읽은 수는 전달
   * 방식과 무관하고, 여기가 비면 기록이 어댑터마다 갈린다(§6.3).
   */
  readonly store: MessageStore
  /** `inbox` 툴을 노출한 어댑터만 참이다. 아니면 툴이 오류를 돌려준다. */
  readonly hasInbox?: boolean
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
        return await handleChannels(ctx)
      case 'inbox':
        return await handleInbox(ctx, args)
      case 'whoami':
        return handleWhoami(ctx, args)
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

  // 나간 뒤에 기록한다 (§6.3 — 저장은 코어의 일이고, 조망 UI 는 내가 보낸
  // 것도 봐야 한다). `send` 는 봉투 바이트를 주지 보관용 id 를 주지 않으므로
  // id 는 저장소가 뽑게 둔다.
  let noted = ''
  try {
    await ctx.store.append({
      channelId,
      direction: 'out',
      axis: ctx.node.axisOf(channelId),
      text,
      sentAt: Date.now(),
    })
  } catch (e) {
    // **"못 보냈다"고 말하지 않는다** — 이미 나갔고, 회수할 수 없다(§5.3).
    // 여기서 오류로 돌리면 모델이 다시 보내 같은 말이 두 번 나간다.
    noted = ` · 기록 실패: ${e instanceof Error ? e.message : String(e)}`
  }
  return { text: `보냈다 (남은 예산 ${speech.remaining})${noted}` }
}

async function handleChannels(ctx: HandlerContext): Promise<ToolResult> {
  const ids = ctx.node.channelIds()
  if (ids.length === 0) return { text: '붙어 있는 채널이 없다.' }

  const lines: string[] = []
  for (const id of ids) {
    const channel = ctx.node.channel(id)!
    const members = channel
      .list()
      .map(m => `    ${m.label ?? '(이름 없음)'}  fp ${toHex(m.fingerprint)}`)
      .join('\n')
    // 안 읽음 = 아직 세션에 전달되지 않은 것 (§6.6). 저장소의 전달 상태가
    // 그 판단의 단일 근거다 — 여기서 따로 세면 두 벌이 갈린다.
    const unread = (await ctx.store.undelivered(id)).length
    lines.push(`${channel.name || '(이름 없는 채널)'}\n  id ${id} · 안 읽음 ${unread}\n${members}`)
  }
  return { text: lines.join('\n\n') }
}

/**
 * 내 공개키와 지문을 낸다.
 *
 * `onboard.whoami` 를 그대로 쓴다 — CLI 와 툴이 각자 문구를 만들면 지문
 * 표기(§9)가 두 벌이 되고, 사람은 두 화면의 값이 같은 값인지 알 수 없다.
 */
function handleWhoami(ctx: HandlerContext, args: Record<string, unknown>): ToolResult {
  const label = str(args.label)
  return { text: whoami(ctx.node.identity, label === '' ? undefined : label) }
}

/**
 * 저장소를 읽어 §6.1 묶음으로 돌려준다.
 *
 * **릴레이를 치지 않는다**(§4). 드레인은 코어의 루프 하나뿐이고, 여기서
 * 큐를 건드리면 주입 경로와 서로의 메시지를 훔친다.
 *
 * 내가 보낸 것(`direction: 'out'`)은 빼고 보여준다 — 저장소는 양방향을 다
 * 들고 있지만(조망 UI 가 그걸 본다), "도착한 메시지"를 묻는 툴이 내 발화를
 * 되돌려주면 모델이 그것을 응답 대상으로 읽는다.
 */
async function handleInbox(
  ctx: HandlerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.hasInbox) return { text: '이 어댑터에는 수신함이 없다', isError: true }

  const channelId = str(args.channel_id)
  const limit = intArg(args.limit, INBOX_LIMIT)
  const ids = channelId ? [channelId] : await ctx.store.channels()

  const shown: StoredMessage[] = []
  for (const id of ids) {
    for (const m of await ctx.store.read(id, limit)) if (m.direction === 'in') shown.push(m)
  }
  if (shown.length === 0) return { text: '새 메시지가 없다.' }

  // 이미 전달된 것도 포함해 오염을 찍는다 (§8.3) — 지금 이 호출로 그 말이
  // 컨텍스트에 다시 들어가기 때문이다. 여기가 비면 사용자가 오염을 푼 뒤
  // `inbox` 를 부르는 것이 그대로 우회로가 된다.
  await addTaint(ctx.store.directory, shown)

  // 보여준 것은 전달된 것이다 (§6.6). 표시하지 않으면 훅 안전망이 같은
  // 메시지를 다시 들이밀어, 세션에는 두 번 도착한 것처럼 보인다.
  const fresh = shown.filter(m => !m.delivered).map(m => m.id)
  if (fresh.length > 0) await ctx.store.markDelivered(fresh)

  return { text: renderBundle(shown, { markNew: true }) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 1 이상의 정수만 받는다. 어긋나면 기본값 — 툴 인자로 저장소를 죽이지 않는다. */
function intArg(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback
}
