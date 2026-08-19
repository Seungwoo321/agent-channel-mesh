/**
 * 발화 제어 — 종료 조건 없는 대화를 만들지 않는다
 *
 * 설계 근거는 docs/architecture.md §7.
 *
 * 에이전트끼리 자율로 대화하면 목적 없는 무한 왕복에 빠진다. 사람 채팅에
 * 없는 실패 양식이라 프로토콜이 직접 막는다. 이 모듈은 "응답해도 되는가"
 * 하나만 판정하고, 실제 발화는 어댑터가 한다.
 *
 * 네 장치가 서로를 보완한다 — 멘션은 대화 시작을, 에코 억제는 자기 유발
 * 왕복을, 홉 제한은 사슬 길이를, 예산은 총량을 막는다. 하나로는 부족하다:
 * 멘션만 두면 서로 멘션하는 두 에이전트가 영원히 돈다.
 */

/** 한 사슬의 연속 왕복 상한. 초과하면 사람에게 넘긴다. */
export const DEFAULT_MAX_HOPS = 8

/** 채널당 메시지 예산. 소진하면 정지한다. */
export const DEFAULT_MESSAGE_BUDGET = 100

/**
 * 응답하지 않는 이유 전부. 이 값이 그대로 저장소의 `mute` 로 남고
 * 렌더에 실려 모델에게 보이므로, `mesh-usage` 스킬이 넷을 다 설명해야 한다
 * (`test/plugin.test.ts` 가 대조).
 *
 * - `not-mentioned` 나를 부르지 않았다 — 읽되 응답하지 않는다
 * - `echo` 내가 유발한 메시지다 — 자동 응답하면 자기와 대화한다
 * - `hop-limit` 사슬이 너무 길다
 * - `budget` 예산 소진
 */
export const SILENCE_REASONS = ['not-mentioned', 'echo', 'hop-limit', 'budget'] as const

export type SilenceReason = (typeof SILENCE_REASONS)[number]

export type Decision =
  | { readonly speak: true; readonly hops: number }
  | { readonly speak: false; readonly reason: SilenceReason; readonly detail: string }

/** 발화 판정에 필요한 수신 메시지 정보. */
export interface Incoming {
  /** 발신자 KEM key id. 에코 판정에 쓴다. */
  readonly senderKeyId: Uint8Array
  /** 복호화된 본문. 멘션 탐지에 쓴다. */
  readonly text: string
  /**
   * 이 메시지가 속한 사슬의 홉 수. 발신자가 자기 홉 + 1 을 실어 보낸다.
   *
   * 신뢰할 수 없는 값이지만 — 발신자가 0 으로 위조할 수 있다 — 예산이
   * 뒤를 받친다. 위조로 홉 제한을 피해도 총량에서 걸린다.
   */
  readonly hops?: number
}

export interface SpeechOptions {
  /** 내 key id. 에코 판정 기준. */
  readonly selfKeyId: Uint8Array
  /**
   * 내가 응답할 멘션 이름들. 비우면 **모든 메시지에 응답**한다 —
   * 1:1 사람↔에이전트 대화의 기본값이다.
   */
  readonly mentions?: readonly string[]
  readonly maxHops?: number
  readonly messageBudget?: number
}

/**
 * 채널 하나의 발화 제어 상태.
 *
 * 채널마다 인스턴스를 둔다 — 예산이 채널·작업 단위라서다 (§7).
 */
export class SpeechControl {
  private readonly selfKey: string
  private readonly mentions: readonly string[]
  private readonly maxHops: number
  private readonly budget: number
  private spent = 0

  constructor(options: SpeechOptions) {
    this.selfKey = hex(options.selfKeyId)
    this.mentions = (options.mentions ?? []).map(m => m.toLowerCase())
    this.maxHops = options.maxHops ?? DEFAULT_MAX_HOPS
    this.budget = options.messageBudget ?? DEFAULT_MESSAGE_BUDGET
  }

  /**
   * 응답해도 되는가 — 판정만 한다. 상태를 바꾸지 않는다.
   *
   * 순서는 싼 것부터다. 에코가 가장 싸고(문자열 비교 한 번), 멘션 탐지가
   * 가장 비싸다(본문 스캔).
   */
  check(incoming: Incoming): Decision {
    // 1. 에코 — 내 메시지에 내가 응답하지 않는다.
    if (hex(incoming.senderKeyId) === this.selfKey) {
      return no('echo', '내가 보낸 메시지다')
    }

    // 2. 예산 — 정수 비교.
    if (this.spent >= this.budget) {
      return no('budget', `메시지 예산을 다 썼다 (${this.spent}/${this.budget})`)
    }

    // 3. 홉 — 사슬이 길어지면 사람에게 넘긴다.
    const hops = incoming.hops ?? 0
    if (hops >= this.maxHops) {
      return no('hop-limit', `홉 상한을 넘었다 (${hops}/${this.maxHops}) — 사람에게 넘긴다`)
    }

    // 4. 멘션 — 본문을 봐야 하므로 마지막이다.
    if (this.mentions.length > 0 && !this.mentioned(incoming.text)) {
      return no('not-mentioned', '나를 부르지 않았다 — 읽되 응답하지 않는다')
    }

    return { speak: true, hops: hops + 1 }
  }

  /**
   * 발화를 기록한다. `check` 가 통과하고 **실제로 보냈을 때만** 부른다.
   *
   * 판정과 기록을 나누는 이유: 판정 후 발화가 취소될 수 있고, 그때
   * 예산이 깎이면 안 된다.
   */
  spend(): void {
    this.spent++
  }

  /** 남은 예산. 사람에게 보여줄 값이다. */
  get remaining(): number {
    return Math.max(0, this.budget - this.spent)
  }

  get used(): number {
    return this.spent
  }

  /** 작업이 끝나 예산을 되돌린다. */
  reset(): void {
    this.spent = 0
  }

  /**
   * 멘션 탐지.
   *
   * `@이름` 과 맨이름 둘 다 인정한다. 단어 경계를 보므로 `@alice-bot` 의
   * 일부인 `alice` 는 잡히지 않는다 — 다른 에이전트를 부른 것을
   * 자기 호출로 오인하면 그게 곧 무한 왕복이다.
   */
  private mentioned(text: string): boolean {
    const lower = text.toLowerCase()
    return this.mentions.some(name => {
      let from = 0
      for (;;) {
        const at = lower.indexOf(name, from)
        if (at < 0) return false
        const before = at > 0 ? lower[at - 1]! : ''
        const after = lower[at + name.length] ?? ''
        if (!isWordChar(before) && !isWordChar(after)) return true
        from = at + name.length
      }
    })
  }
}

/**
 * 단어 문자 판정.
 *
 * 한글·CJK 를 포함한다 — `@앨리스님` 의 `앨리스` 를 멘션으로 오인하면
 * 안 된다. 반대로 `앨리스,` 나 `@앨리스 ` 는 멘션이다.
 */
function isWordChar(c: string): boolean {
  if (c === '') return false
  return /[\p{L}\p{N}_-]/u.test(c)
}

const no = (reason: SilenceReason, detail: string): Decision => ({ speak: false, reason, detail })

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
