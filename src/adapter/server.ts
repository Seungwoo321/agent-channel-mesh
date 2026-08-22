/**
 * stdio MCP 서버 — 어댑터를 실제 프로세스로 만든다
 *
 * 설계 근거는 docs/architecture.md §4「어댑터」· §6.3 · §6.6.
 *
 * 두 어댑터가 같은 서버를 쓴다. 갈리는 것은 **도착한 메시지를 어떻게 알리느냐**
 * 하나뿐이다:
 *
 *   - `push`  — `notifications/claude/channel` 로 세션에 밀어 넣는다 (Claude).
 *   - `inbox` — 저장소에 쌓고 `inbox` 툴로 꺼내 가게 한다 (Codex 등).
 *   - `both`  — 둘 다. Claude 에서 기본으로 쓸 형태다 (§4).
 *
 * **어느 쪽이든 릴레이를 드레인하는 루프는 하나다.** 큐는 드레인하면 사라지므로
 * (§5.3) 두 경로가 각자 릴레이를 치면 서로의 메시지를 훔친다. 그래서 순서가
 * 고정돼 있다 — **저장이 먼저, 알림이 나중**이다. 저장소가 정본이고 주입은
 * 알림이다(§4).
 *
 * 서버가 stdio 인 것은 선택이 아니다 — 스파이크에서 확인된 제약이다.
 * 세션에 닿으려면 로컬 프로세스가 반드시 존재한다.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { MeshNode, Dropped } from '../node/node.js'
import type { MessageStore, ReceiverLease, StoredMessage } from '../store/store.js'
import {
  callTool,
  SEND_TOOL,
  CHANNELS_TOOL,
  INBOX_TOOL,
  WHOAMI_TOOL,
  type ToolSpec,
} from './tools.js'
import { CONFIGURE_TOOLS, isConfigureTool, runConfigure } from './configure.js'
import { RELAY_CHECK_TOOL, RELAY_EXPORT_TOOL, runRelayCheck, runRelayExport } from './relay-setup.js'
import { ClaudeAdapter, CAPABILITIES, INSTRUCTIONS, type PushStatus } from './claude.js'
import { hex } from './bundle.js'
import { addTaint } from '../policy/taint.js'

export const SERVER_NAME = 'agent-channel-mesh'
export const SERVER_VERSION = '0.1.0'

/**
 * 전달 방식.
 *
 * `push` 는 Claude Code 전용이다 — `claude/channel` 이 Anthropic 확장이라
 * 다른 에이전트에서는 선언해도 아무 일도 일어나지 않는다. `both` 는 그 위에
 * 폴링 경로를 겸한다: 주입은 개발 플래그에 걸린 실험 기능이라 그것이 막히면
 * 폴링 없는 사용자는 통째로 막히고, §6.1 의 "며칠 밀린 묶음"은 애초에
 * 꺼내오는 동작을 전제한다(§4).
 */
export type Delivery = 'push' | 'inbox' | 'both'

/**
 * 주입 합류 시간(ms) 기본값 (§6.6).
 *
 * 주입은 턴 없이 꽂히므로 도착 즉시 쏘면 3건이 1분 간격으로 올 때 주입이 세
 * 번 일어나고, §6.1 의 "묶어서 한 번에"가 깨진다. 짧게 모았다가 내보내며 그
 * 사이에 온 것은 같이 묶는다. 1.5초는 사람이 지연으로 느끼지 않으면서
 * 릴레이 폴링 한 배치가 들어오기에 충분한 폭이다.
 */
export const DEFAULT_COALESCE_MS = 1500

/**
 * 종료할 때 진행 중인 묶음의 뒷정리를 기다리는 상한(ms).
 *
 * 기다리는 대상은 주입이 아니라 **선점 정리**다 — 선점만 찍힌 채 프로세스가
 * 사라지면 리스 기한(기본 60초)까지 훅 안전망에도 안 보이기 때문이다. 정상
 * 경로에서 그 정리는 파일 쓰기 한 번이라 ms 단위로 끝난다. 2초는 그보다 세
 * 자릿수 넉넉하면서, 파이프가 이미 끊긴 경우에 종료가 눈에 띄게 걸리지 않는
 * 폭이다.
 */
export const STOP_SETTLE_MS = 2000

export interface ServeOptions {
  readonly node: MeshNode
  readonly delivery: Delivery
  /**
   * 정본 저장소 (§6.3). **필수다.**
   *
   * 기본값으로 메워 주지 않는다 — 저장 위치는 신원에서 파생하는데
   * ({@link storeOptionsOf}) 여기서 인자 없이 세우면 그 파생을 건너뛴 상수
   * 경로에 서고, 한 기계의 두 신원이 같은 채널 파일을 공유한다.
   */
  readonly store: MessageStore
  /**
   * 설정 파일 경로. 주면 설정을 고치는 툴이 함께 뜬다 (§11).
   *
   * 없으면 그 툴들이 아예 없다 — 어느 파일을 고칠지 모르는 채로 짐작해서
   * 열면 사용자가 쓰는 설정이 아닌 파일을 고치고, 고쳤다고 보고한다.
   */
  readonly configPath?: string
  /** 기동 시 읽은 설정의 신원 fingerprint. 설정 mutation guard에 전달한다. */
  readonly runtimeFingerprint?: string
  /** 주입 합류 시간(ms). `push` 가 없으면 쓰이지 않는다. */
  readonly coalesceMs?: number
  /** 모델에게 줄 지시. 생략하면 전달 방식에 맞는 기본 문구. */
  readonly instructions?: string
  readonly onDropped?: (d: Dropped) => void
}

const INBOX_INSTRUCTIONS =
  'Other agents and people can message you over agent-channel-mesh. ' +
  'Session hooks may surface unread messages at turn boundaries, but hooks are a fallback, ' +
  'not the source of truth; call the inbox tool to read them, ' +
  'and do so at task boundaries so you do not miss requests. ' +
  'It returns them grouped by channel, oldest first, headed by sender and ' +
  'absolute timestamps; read the whole batch before replying to any one message. ' +
  'A message tagged [응답 안 함] is for context only: read it, do not reply. ' +
  'Reply with the send tool, passing the channel_id shown on the message.'

const BOTH_INSTRUCTIONS =
  `${INSTRUCTIONS} ` +
  'The same messages are also kept locally: call the inbox tool to re-read them, ' +
  'or to catch anything a notification failed to deliver. ' +
  'Entries marked [새 메시지] had not reached this session yet.'

/**
 * 어댑터를 stdio MCP 서버로 띄운다.
 *
 * 돌려주는 `stop` 을 부르면 폴링과 서버가 함께 멈춘다.
 */
export async function serve(options: ServeOptions): Promise<{ stop: () => Promise<void> }> {
  const { node, delivery } = options
  const store = options.store
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS

  // 두 성질은 서로 배타가 아니다 — `both` 가 둘 다 켠다.
  const push = delivery !== 'inbox'
  const inboxTool = delivery !== 'push'

  const tools: ToolSpec[] = [SEND_TOOL, CHANNELS_TOOL, WHOAMI_TOOL, RELAY_CHECK_TOOL, RELAY_EXPORT_TOOL]
  if (inboxTool) tools.push(INBOX_TOOL)
  if (options.configPath !== undefined) tools.push(...CONFIGURE_TOOLS)

  // MCP 요청 핸들러는 connect 뒤에 호출되지만, adapter는 그 시점에야
  // 만들 수 있다. 선언을 먼저 해 두면 응답에 push 상태를 항상 붙일 수 있다.
  let adapter: ClaudeAdapter | undefined
  let receiverLease: ReceiverLease | undefined
  let receiverError: Error | undefined
  let receiverLost = false
  const explicitRelay = node.hasRelay

  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      // 능동 주입을 쓰지 않을 때 capability 를 선언하지 않는다 — 못 하는
      // 것을 선언하면 호스트가 할 수 있다고 믿는다.
      capabilities: push ? CAPABILITIES : { tools: {} },
      instructions: options.instructions ?? defaultInstructions(delivery),
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    if (req.params.name === RELAY_CHECK_TOOL.name) {
      const checked = await runRelayCheck(args)
      return { content: [{ type: 'text', text: checked.text }], isError: checked.isError }
    }
    if (req.params.name === RELAY_EXPORT_TOOL.name) {
      const made = await runRelayExport(args)
      return { content: [{ type: 'text', text: made.text }], isError: made.isError }
    }
    if (options.configPath !== undefined && isConfigureTool(req.params.name)) {
      const changed = await runConfigure(
        {
          configPath: options.configPath,
          taintDir: store.directory,
          ...(options.runtimeFingerprint !== undefined
            ? { runtimeFingerprint: options.runtimeFingerprint }
            : {}),
        },
        req.params.name,
        args,
      )
      return { content: [{ type: 'text', text: changed.text }], isError: changed.isError }
    }

    const result = await callTool(
      { node, store, hasInbox: inboxTool },
      req.params.name,
      args,
    )
    const unread =
      inboxTool && req.params.name !== INBOX_TOOL.name ? await unreadNotice(store) : ''
    return {
      content: [{
        type: 'text',
        text: `${result.text}${unread}${runtimeNotice(
          node,
          delivery,
          options.configPath,
          adapter,
          receiverLease !== undefined,
          receiverError,
          receiverLost,
        )}`,
      }],
      isError: result.isError,
    }
  })

  await mcp.connect(new StdioServerTransport())

  adapter = push
    ? new ClaudeAdapter({
        notify: n => mcp.notification(n as Parameters<typeof mcp.notification>[0]),
        onError: e => warn(`주입이 실패했다: ${String(e)}`),
      })
    : undefined

  // 같은 identity 저장소를 쓰는 adapter가 둘이면 릴레이 큐를 서로 훔친다.
  // 훅은 이 lease를 잡지 않고 저장소 fallback만 읽으므로, 하나의 MCP receiver와
  // 여러 훅 프로세스가 공존할 수 있다.
  if (explicitRelay === true) {
    try {
      receiverLease = await store.acquireReceiverLease({
        onLost: error => {
          receiverLost = true
          warn(`수신 lease를 잃었다: ${error.message}`)
          node.stop()
        },
      })
    } catch (error) {
      receiverError = error instanceof Error ? error : new Error(String(error))
      warn(`수신 루프를 시작하지 않았다: ${receiverError.message}`)
    }
  }

  // 합류 창(§6.6). 타이머가 떠 있는 동안 도착한 것은 같은 묶음으로 나간다.
  // `push` 가 아니면 타이머 자체를 만들지 않는다 — 수신함 전용은 저장만 하고
  // 툴이 꺼내 간다.
  //
  // **타이머는 창이지 상호배제가 아니다.** 창이 닫혀 묶음이 나가기 시작한
  // 뒤에도 새 메시지는 새 창을 연다 — 주입이 창보다 오래 걸리면(호스트가
  // 파이프를 늦게 읽을 때 실제로 그렇다) 두 창이 겹친다. 그래서 잠금이
  // 따로 필요하다.
  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * 진행 중인 묶음. 다음 묶음은 이 프라미스가 끝난 뒤에 시작한다.
   *
   * 임계 구간은 합류 창이 아니라 **드레인 → 주입 → 표시** 전체다. 주입은
   * 호스트가 파이프를 읽어 줄 때까지 걸리고, 그 사이에 다음 묶음이 같은
   * 메시지를 다시 집으면 두 번 주입된다. `delivered` 상태만으로는 못
   * 막는다 — 상태는 **이미 끝난** 전달을 기억할 뿐, 진행 중인 전달을
   * 알리지 못하기 때문이다.
   *
   * 이 사슬은 그중 **한 프로세스 안**만 직렬화한다. 훅은 별개 프로세스라
   * 이 프라미스를 보지 못하므로, 프로세스를 건너는 배타는 선점(리스)이
   * 맡는다 — 아래 {@link drain} 참고.
   */
  let inFlight: Promise<void> = Promise.resolve()

  /**
   * 미전달분을 **선점해서** 꺼내 주입하고, 결과에 따라 굳히거나 풀어 준다.
   *
   * 조회(`undelivered`)가 아니라 선점(`claimUndelivered`)인 이유: 훅
   * 안전망(§6.6)은 별개 프로세스로 같은 저장소를 본다. 조회는 아무 흔적을
   * 남기지 않으므로 어댑터가 주입하는 동안 훅이 같은 메시지를 집어 들고,
   * 세션에는 같은 말이 두 번 뜬다. 선점은 잠금 안에서 `claimedAt` 을 찍고
   * 돌려주므로, 찍힌 것은 다른 프로세스의 선점에 걸리지 않는다.
   *
   * 그럼에도 `delivered` 를 주입 **전에** 찍지는 않는다. 그 사이에
   * 프로세스가 죽으면 되돌릴 주체가 없어 메시지가 영영 사라진다 — 훅이
   * 집어 갈 근거가 미전달 상태 하나뿐이기 때문이다. 선점은 그 점에서
   * 다르다: 리스는 기한(`claimTtlMs`)이 있어 홀더가 죽으면 저절로 풀린다.
   */
  const drain = async () => {
    const batch = await store.claimUndelivered()
    if (batch.length === 0) return

    let delivered: readonly string[] = []
    try {
      // 오염은 주입 **전에** 찍는다 (§8.3). 뒤에 찍으면 세션에는 들어갔는데
      // 오염은 안 찍힌 창이 생기고, 그 창의 말이 그대로 툴 호출을 연다.
      // 여기서 던지면 주입 자체가 일어나지 않고 아래에서 선점이 풀린다.
      await addTaint(store.directory, batch)
      delivered = await adapter!.inject(batch)
    } finally {
      // 주입이 던져도 정리한다. 안 하면 선점한 묶음이 기한(기본 60초)까지
      // 아무에게도 안 보이고, 그동안 훅 안전망이 그 메시지를 못 집는다.
      await settle(batch, delivered)
    }
  }

  /**
   * 선점을 정리한다. 나간 것은 전달로 굳히고, **못 나간 것은 즉시 푼다.**
   *
   * 푸는 것이 핵심이다. 채널 하나가 실패하면 `inject` 는 그 id 를 돌려주지
   * 않는데(§claude.ts), 선점만 남고 아무도 안 풀면 그 메시지는 기한이 찰
   * 때까지 훅에도 안 잡힌다. 실패는 즉시 다음 창과 훅 둘 다에 열려야 한다.
   *
   * 여기서 나는 예외는 삼킨다 — 원래의 주입 실패를 덮으면 진단이 어긋나고,
   * 정리에 실패해도 리스 기한이 같은 일을 늦게나마 해 준다.
   */
  const settle = async (batch: readonly StoredMessage[], delivered: readonly string[]) => {
    const sent = new Set(delivered)
    const back = batch.filter(m => !sent.has(m.id)).map(m => m.id)
    try {
      if (delivered.length > 0) await store.markDelivered(delivered)
      if (back.length > 0) await store.release(back)
    } catch (e) {
      warn(`선점을 정리하지 못했다: ${String(e)}`)
    }
  }

  // 한 묶음이 던져도 사슬을 끊지 않는다 — 여기서 거절이 남으면 다음 묶음이
  // 영원히 시작되지 않고 수신이 통째로 멈춘다. 실패한 묶음은 미전달로
  // 남아 다음 창에 다시 시도된다.
  const flush = () => {
    inFlight = inFlight.then(drain).catch(e => warn(`주입 묶음을 내보내지 못했다: ${String(e)}`))
    return inFlight
  }

  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, coalesceMs)
  }

  // 릴레이를 치는 유일한 곳이다 (§4). 어댑터도 툴도 여기를 거친다.
  // 외부 fake node는 이전 ServeOptions 계약처럼 hasRelay를 제공하지 않을 수
  // 있다. 그 경우에는 기존처럼 listen()을 호출한다. 실제 MeshNode는 boolean을
  // 항상 제공하므로, 릴레이 없는 로컬 노드는 불필요한 listen 오류를 내지 않는다.
  const shouldListen = explicitRelay === undefined || receiverLease !== undefined
  const loop = !shouldListen
    ? Promise.resolve()
    : (async () => {
        for await (const m of node.listen(options.onDropped)) {
          await store.append({
            id: hex(m.messageId),
            channelId: m.channelId,
            direction: 'in',
            // 축은 저장 시점에 박힌다 (§6.4) — UI 이전에 여기서 갈려 있어야
            // 내부 위임과 외부 대화가 섞이지 않는다.
            axis: node.axisOf(m.channelId),
            senderKeyId: hex(m.senderKeyId),
            ...(m.senderLabel !== undefined ? { senderLabel: m.senderLabel } : {}),
            text: m.text,
            sentAt: Number(m.sentAt),
            hops: m.hops,
            // 권한도 축과 같은 이유로 저장 시점에 박힌다 (§8). 나중에 정책이
            // 바뀌어도 "이 말을 무슨 권한으로 들였는지"는 바뀌면 안 되고,
            // 정본을 읽는 `inbox`·훅이 그 값을 그대로 봐야 판정이 한 벌이다.
            authority: m.authority,
            grant: m.grant,
            // 발화 판정은 **도착 시점에만** 구할 수 있다 (§7). 여기서 안 남기면
            // 정본을 읽는 `inbox` 툴이 남의 대화를 응답 대상처럼 내준다.
            ...(m.decision.speak ? {} : { mute: m.decision.reason }),
          })
          if (push) schedule()
        }
      })()
  // 루프가 죽어도 서버는 살려 둔다 — 릴레이 장애가 툴까지 끊으면 안 된다.
  // 다만 조용히 삼키지는 않는다. 폴링이 죽은 채 툴만 응답하면 "보낼 수는
  // 있는데 받지는 못하는" 상태가 되고, 그건 진단이 불가능하다.
  loop.catch(e => warn(`수신 루프가 멈췄다: ${String(e)}`))

  return {
    stop: async () => {
      // 대기 중인 묶음을 억지로 내보내지 않는다. 미전달로 남으면 훅
      // 안전망(§6.6)이 다음 프롬프트에 그것을 집어 든다 — 반대로 종료
      // 도중에 쏘면 세션이 이미 닫혀 알림이 허공으로 가고, 그때
      // `markDelivered` 까지 찍히면 그 메시지는 어디에도 도달하지 못한다.
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined

      // 다만 **이미 시작된** 묶음의 뒷정리는 기다린다. 새 묶음을 여는 것과
      // 다르다 — 선점만 찍힌 채로 프로세스가 사라지면 그 메시지는 리스
      // 기한(기본 60초)이 찰 때까지 훅에도 안 보인다. 인계가 일어나는 바로
      // 그 순간에 안전망이 비는 셈이라, 정리가 끝날 틈은 주고 나간다.
      //
      // 무한정 기다리지는 않는다. 호스트가 파이프를 이미 놓았으면 주입이
      // 영영 안 끝나고, 그러면 종료가 걸린다. 기다림이 헛되면 리스 기한이
      // 늦게나마 같은 일을 한다.
      await Promise.race([inFlight, sleep(STOP_SETTLE_MS)])

      node.stop()
      try {
        await mcp.close()
      } finally {
        if (receiverLease !== undefined) {
          await receiverLease.release().catch(e => warn(`수신 lease를 해제하지 못했다: ${String(e)}`))
          receiverLease = undefined
        }
      }
    },
  }
}

function defaultInstructions(delivery: Delivery): string {
  if (delivery === 'push') return INSTRUCTIONS
  if (delivery === 'inbox') return INBOX_INSTRUCTIONS
  return BOTH_INSTRUCTIONS
}

/**
 * 수신함 훅이 빠졌거나 push가 막힌 세션도 다음 툴 호출에서 스스로 진단하게 한다.
 * 자동 알림은 관측 경로가 아니므로, 저장소·릴레이·push 상태를 응답에 함께 낸다.
 */
function runtimeNotice(
  node: MeshNode,
  delivery: Delivery,
  configPath: string | undefined,
  adapter: ClaudeAdapter | undefined,
  receiverActive: boolean,
  receiverError: Error | undefined,
  receiverLost: boolean,
): string {
  const lines: string[] = []
  if (configPath !== undefined) lines.push(`설정 경로: ${configPath}`)

  const health = node.relayHealth
  if (health === undefined) {
    lines.push('릴레이 상태: 연결 없음 (로컬 전용 또는 아직 초기화되지 않음)')
  } else if (health.consecutiveFailures > 0) {
    const error = health.lastError?.message ?? '알 수 없는 오류'
    const status = health.lastError?.status === undefined ? '' : ` · HTTP ${health.lastError.status}`
    lines.push(
      `릴레이 상태: 오류 ${health.consecutiveFailures}회 연속${status} — ${error}`,
    )
    if (health.lastSuccessAt !== undefined) {
      lines.push(`마지막 릴레이 성공 조회: ${new Date(health.lastSuccessAt).toISOString()}`)
    }
  } else if (health.lastSuccessAt !== undefined) {
    lines.push(`마지막 릴레이 성공 조회: ${new Date(health.lastSuccessAt).toISOString()}`)
  } else {
    lines.push('릴레이 상태: 아직 성공한 조회가 없음')
  }

  if (health !== undefined && !receiverActive) {
    lines.push(
      receiverLost
        ? '수신 루프 상태: lease를 잃어 중단됨'
        : `수신 루프 상태: 시작되지 않음 — ${receiverError?.message ?? 'receiver lease 없음'}`,
    )
  }

  if (delivery !== 'inbox') {
    const pushStatus: PushStatus | undefined = adapter?.pushStatus
    if (pushStatus?.state === 'available') {
      lines.push('Claude push 상태: 사용 가능')
    } else if (pushStatus?.state === 'unavailable') {
      lines.push(
        `Claude push 상태: 사용할 수 없음 — ${pushStatus.lastError ?? '원인 미상'}; ` +
          (delivery === 'both' ? 'inbox fallback을 사용하라.' : 'push만 활성화되어 fallback이 없다.'),
      )
    } else {
      lines.push(
        'Claude push 상태: 아직 성공 확인 전 — 개발 채널 권한이 없으면 push가 실패하므로 ' +
          (delivery === 'both' ? 'inbox fallback을 사용하라.' : 'inbox 모드로 다시 연결하라.'),
      )
    }
  }

  return lines.length === 0 ? '' : `\n\n[ACM 상태]\n${lines.join('\n')}`
}

async function unreadNotice(store: MessageStore): Promise<string> {
  try {
    const unread = (await store.undelivered()).length
    return unread === 0 ? '' : `\n\n[미읽음 ${unread}건 — inbox 툴을 호출해 읽어라.]`
  } catch (e) {
    warn(`미읽음 수를 확인하지 못했다: ${String(e)}`)
    return '\n\n[미읽음 수를 확인하지 못했다 — inbox 툴을 직접 호출해라.]'
  }
}

/** stdout 은 MCP 프레이밍이 쓴다 — 진단은 stderr 로만 나간다. */
function warn(message: string): void {
  process.stderr.write(`[agent-channel-mesh] ${message}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
