/**
 * Claude Code 어댑터 — 능동 주입
 *
 * 설계 근거는 docs/architecture.md §4「Claude Code 어댑터」.
 *
 * **`claude/channel` 이 존재해도 되는 유일한 파일이다.** 코어는 이 이름을
 * 모른다 (CLAUDE.md「코어와 어댑터 경계」). 여기가 하는 일은 하나다 —
 * 서버가 "이것들을 알려라"라고 넘겨 주면 그것을 세션에 밀어 넣는다.
 *
 * **릴레이를 치지 않는다.** 드레인은 서버가 소유하는 루프 하나뿐이고(§4),
 * 여기가 자기 루프를 돌면 큐가 서로의 메시지를 훔친다 — 주입으로 받은 것이
 * `inbox` 툴에 안 보이고 그 반대도 된다. 그리고 주입은 **알림**이지 정본이
 * 아니다. 정본은 로컬 저장소다(§6.3).
 *
 * 스파이크(spike/channel.ts)로 4/4 검증된 프로토콜을 그대로 쓴다:
 *   - `experimental: { 'claude/channel': {} }` 로 채널 등록
 *   - `notifications/claude/channel` 로 인바운드 주입
 *   - 툴 호출로 아웃바운드
 *
 * 제약도 스파이크에서 확인됐다 — 채널은 stdio 서브프로세스다. 순수
 * 서버리스만으로는 세션에 닿을 수 없고, 로컬 프로세스가 반드시 존재한다.
 */
import type { StoredMessage } from '../store/store.js'
import { SEND_TOOL, CHANNELS_TOOL, type ToolSpec } from './tools.js'
import { groupByChannel, renderBundle, senderOf } from './bundle.js'

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
  readonly notify: Notify
  /** 주입 실패를 알린다. 없으면 조용히 미전달로 남긴다. */
  readonly onError?: (e: unknown) => void
}

/** `inject` 에 배치 단위 판단을 넘긴다. */
export interface InjectOptions {
  /** 머리 지시를 붙일지. 생략하면 채널 그룹별 건수로 정해진다. */
  readonly head?: boolean
}

/**
 * 모델에게 주는 지시.
 *
 * 채널 메시지가 `<channel source="..." chat_id="...">` 로 도착한다는 것과,
 * 답할 때 무엇을 써야 하는지를 알려 준다. 이 문자열이 없으면 모델은 도착한
 * 태그를 사용자 발화로 오해한다.
 *
 * **묶음으로 온다는 사실도 여기 적는다.** 형식 자체는 어댑터가 강제하지만
 * (§6.1), 한 알림 안에 여러 건이 들어 있다는 것을 모르면 모델이 맨 앞 한
 * 건만 읽고 답할 여지가 남는다.
 */
export const INSTRUCTIONS =
  'Messages from other agents and people arrive as ' +
  '<channel source="agent-channel-mesh" chat_id="...">. ' +
  'One notification can carry several messages, oldest first, ' +
  'each headed by sender, channel and absolute timestamps — read all of them ' +
  'and report the current state before replying to any single one. ' +
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
 * 저장소를 갖지 않는다 — 정본은 코어의 로컬 저장소이고(§6.3), 여기는 그것을
 * 세션에 알리는 경로일 뿐이다. 그것이 수신함 경로와 갈리는 유일한 지점이다.
 */
export class ClaudeAdapter {
  private readonly notify: Notify
  private readonly onError?: (e: unknown) => void

  constructor(options: ClaudeAdapterOptions) {
    this.notify = options.notify
    this.onError = options.onError
  }

  /**
   * 묶음을 세션에 주입하고, **실제로 알림이 나간 메시지 id 들**을 준다.
   *
   * 반환값으로 호출자가 `markDelivered` 한다 — 나가지 않은 것을 전달됐다고
   * 표시하면 훅 안전망(§6.6)이 그것을 못 보게 되고, 그 메시지는 어디에도
   * 도달하지 못한 채 조용히 사라진다.
   *
   * 발화 판정과 무관하게 **전부 주입한다** — "읽되 응답하지 않는다"가 멘션
   * 규칙의 정의이고(§7), 읽히지 않으면 그건 필터링이지 발화 제어가 아니다.
   * 응답 여부는 렌더에 실린 표시를 보고 모델이 정한다.
   */
  async inject(
    messages: readonly StoredMessage[],
    options: InjectOptions = {},
  ): Promise<string[]> {
    if (messages.length === 0) return []

    // 머리 지시는 **배치 전체 기준**으로 한 번 정하고 모든 채널에 같은 값을
    // 넘긴다. 즉답 반사는 채널이 아니라 세션 수준의 실패다 — 채널마다 1건씩
    // 다섯 채널이 밀렸는데 어디에도 지시가 안 붙으면 §6.1 이 비는 셈이다.
    const head = options.head ?? messages.length >= 2

    const delivered: string[] = []
    for (const group of groupByChannel(messages)) {
      try {
        await this.notifyChannel(group.channelId, group.messages, head)
        for (const m of group.messages) delivered.push(m.id)
      } catch (e) {
        // 채널 하나가 실패해도 나머지는 보낸다. 실패한 채널의 id 는 돌려주지
        // 않으므로 미전달로 남고, 훅 안전망(§6.6)이 그것을 잡는다.
        this.onError?.(e)
      }
    }
    return delivered
  }

  /**
   * 채널 하나를 알림 하나로 보낸다.
   *
   * `meta` 키는 `[A-Za-z0-9_]` 만 유효하다 — **하이픈은 조용히 삭제된다**
   * (CLAUDE.md「채널 프로토콜」). 그래서 `chat_id` 이지 `chat-id` 가 아니다.
   *
   * 채널을 섞지 않는 이유: `meta.chat_id` 는 하나만 실을 수 있고, 그것이
   * 모델이 답장 대상을 고르는 근거다. 섞으면 A 채널 얘기에 B 채널 id 로
   * 답하게 되고, **잘못 보낸 메시지는 회수할 수 없다**(§5.3).
   */
  private async notifyChannel(
    channelId: string,
    messages: readonly StoredMessage[],
    head: boolean,
  ): Promise<void> {
    await this.notify({
      method: 'notifications/claude/channel',
      params: {
        content: renderBundle(messages, { head }),
        meta: {
          chat_id: channelId,
          // 그룹의 **마지막** 발신자다. 이 값은 알림 하나에 하나뿐인데 묶음은
          // 여러 발신자를 담으므로, 무엇을 골라도 일부는 가린다. 마지막을
          // 고르는 이유는 §6.1 이 막으려는 실패가 "뒤집힌 전제로 답하기"라서다
          // — 가장 최근 발화자가 지금 상태에 가장 가깝다. 발신자별 정확한
          // 귀속은 본문 머리에 이미 전부 적혀 있다.
          sender: senderOf(messages[messages.length - 1]!),
        },
      },
    })
  }
}
