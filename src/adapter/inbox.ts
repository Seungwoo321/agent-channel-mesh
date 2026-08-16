/**
 * 수신함 — 능동 주입이 없는 에이전트를 위한 뒤집힌 전달
 *
 * 설계 근거는 docs/architecture.md §4「그 외 에이전트 어댑터」.
 *
 * `claude/channel` 은 Anthropic 확장이라 다른 에이전트에는 없다. 밀어 넣을 수
 * 없으면 **꺼내 가게** 한다 — 코어가 받은 메시지를 여기 쌓고, 에이전트가
 * `inbox` 툴로 읽는다.
 *
 * 즉시성을 잃지만 협업은 성립한다. 에이전트가 작업 단위 경계마다 확인하면 된다.
 *
 * 이 파일에 에이전트 고유 코드가 없다는 점이 중요하다 — Codex 든 다른
 * 무엇이든 같은 수신함을 쓴다. 갈리는 것은 이걸 어떤 툴로 노출하느냐뿐이다.
 */
import type { Inbound } from '../node/node.js'

/** 수신함 상한. 넘으면 오래된 것부터 버린다. */
export const DEFAULT_CAPACITY = 500

/** 수신함에 쌓인 항목. 읽었는지를 코어가 기억한다. */
export interface InboxItem {
  readonly message: Inbound
  readonly arrivedAt: number
  read: boolean
}

export interface InboxOptions {
  readonly capacity?: number
  readonly now?: () => number
}

/**
 * 로컬 수신함.
 *
 * 읽음 표시를 두는 이유: 에이전트가 여러 번 `inbox` 를 불러도 같은 메시지를
 * 반복해서 처리하지 않아야 한다. 그렇지 않으면 폴링 자체가 무한 왕복이 된다
 * (§7 이 막으려는 바로 그 실패 양식이다).
 *
 * 읽어도 지우지 않는다 — 사람이 "아까 뭐였지"를 물을 수 있어야 한다.
 * 용량 상한이 결국 지운다.
 */
export class Inbox {
  private readonly items: InboxItem[] = []
  private readonly capacity: number
  private readonly now: () => number

  constructor(options: InboxOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    this.now = options.now ?? Date.now
  }

  /** 도착한 메시지를 쌓는다. 코어의 `listen` 루프가 부른다. */
  push(message: Inbound): void {
    this.items.push({ message, arrivedAt: this.now(), read: false })
    // 새 것을 거부하지 않고 오래된 것을 버린다 — 활발한 채널이 죽은
    // 수신함 하나 때문에 막히면 안 된다.
    while (this.items.length > this.capacity) this.items.shift()
  }

  /**
   * 안 읽은 메시지를 읽고 읽음 표시한다.
   *
   * `channelId` 를 주면 그 채널만 본다 — 대화별 컨텍스트 격리(§6)를
   * 어댑터가 실행하는 지점이다. 한 세션이 모든 채널을 한 맥락으로 받으면
   * 맥락이 섞이고 비용이 커진다.
   */
  take(channelId?: string, limit = 50): Inbound[] {
    const out: Inbound[] = []
    for (const item of this.items) {
      if (out.length >= limit) break
      if (item.read) continue
      if (channelId && item.message.channelId !== channelId) continue
      item.read = true
      out.push(item.message)
    }
    return out
  }

  /** 읽음 표시 없이 들여다본다. 사람에게 보여줄 때 쓴다. */
  peek(channelId?: string): readonly InboxItem[] {
    return channelId ? this.items.filter(i => i.message.channelId === channelId) : [...this.items]
  }

  /** 안 읽은 개수. 에이전트에게 "확인할 것이 있다"를 알리는 값이다. */
  unread(channelId?: string): number {
    return this.items.filter(
      i => !i.read && (!channelId || i.message.channelId === channelId),
    ).length
  }

  clear(): void {
    this.items.length = 0
  }

  get size(): number {
    return this.items.length
  }
}
