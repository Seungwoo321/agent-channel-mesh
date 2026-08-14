/**
 * 릴레이 저장소 — TTL 붙은 암호문 blob
 *
 * 설계 근거는 docs/architecture.md §10.7.
 *
 * 릴레이는 **논리적으로 무상태**다 — 세션·래칫·그룹 상태를 갖지 않는다.
 * 다만 오프라인 전달을 위해 암호화된 blob 을 TTL 저장소에 보관한다.
 * 그 내용은 읽을 수 없다.
 *
 * 인터페이스를 따로 두는 이유: Vercel KV·Upstash·메모리 중 어느 것을
 * 쓰든 릴레이 로직이 같아야 한다. 벤더를 릴레이에 용접하면 테스트에
 * 실제 인프라가 필요해지고, 그러면 릴레이 로직이 검증되지 않는다.
 */

/** 저장된 항목 — 릴레이가 보는 전부다. 봉투 내용은 열지 않는다. */
export interface Stored {
  /** 봉투 전송 바이트. 릴레이에게는 불투명한 blob 이다. */
  readonly envelope: Uint8Array
  /** 릴레이 도착 시각(ms). 순서 복원용이며 봉투 timestamp 와 별개다. */
  readonly receivedAt: number
}

/**
 * 큐 저장소.
 *
 * 키는 **수신자 key id** 다 — 채널이 아니라. 한 노드가 여러 채널에
 * 속하므로, 수신자별로 모아야 한 번의 폴링으로 전부 가져간다.
 */
export interface Store {
  /** 수신자 큐에 넣는다. TTL 이 지나면 자동으로 사라져야 한다. */
  push(recipient: string, item: Stored): Promise<void>
  /**
   * 큐를 비우며 꺼낸다.
   *
   * 꺼내면 지우는 것이 기본이다 — 릴레이가 배달 확인을 추적하면
   * 그건 더 이상 무상태가 아니다. 전달 보장은 브릿지의 재전송으로
   * 얻고, 중복은 브릿지의 dedup 이 처리한다 (§10.5).
   */
  drain(recipient: string, limit: number): Promise<Stored[]>
  /** 대기 중인 항목 수. 진단용. */
  depth(recipient: string): Promise<number>
}

/** 항목 TTL. 이 시간이 지나면 전달을 포기한다. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 수신자 한 명당 큐 상한. 무한 적재로 릴레이가 부풀지 않게 한다. */
export const DEFAULT_MAX_QUEUE = 1000

export interface MemoryStoreOptions {
  readonly ttlMs?: number
  readonly maxQueue?: number
  /** 현재 시각. 테스트에서만 주입한다. */
  readonly now?: () => number
}

/**
 * 메모리 저장소.
 *
 * 로컬 개발·테스트용이다. 서버리스 배포에서는 인스턴스마다 별도
 * 메모리를 갖게 되므로 **운영에 쓰면 안 된다** — 그때는 KV 어댑터를 쓴다.
 */
export class MemoryStore implements Store {
  private readonly queues = new Map<string, Stored[]>()
  private readonly ttlMs: number
  private readonly maxQueue: number
  private readonly now: () => number

  constructor(options: MemoryStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
    this.now = options.now ?? Date.now
  }

  async push(recipient: string, item: Stored): Promise<void> {
    const queue = this.live(recipient)
    if (queue.length >= this.maxQueue) {
      // 가장 오래된 것을 버린다. 새 메시지를 거부하면 활발한 채널이
      // 죽은 큐 하나 때문에 막힌다.
      queue.shift()
    }
    queue.push(item)
    this.queues.set(recipient, queue)
  }

  async drain(recipient: string, limit: number): Promise<Stored[]> {
    const queue = this.live(recipient)
    const taken = queue.splice(0, Math.max(0, limit))
    if (queue.length === 0) this.queues.delete(recipient)
    else this.queues.set(recipient, queue)
    return taken
  }

  async depth(recipient: string): Promise<number> {
    return this.live(recipient).length
  }

  /** 만료 항목을 걸러낸 큐. TTL 을 읽는 시점에 적용한다. */
  private live(recipient: string): Stored[] {
    const queue = this.queues.get(recipient)
    if (!queue) return []
    const cutoff = this.now() - this.ttlMs
    return queue.filter(item => item.receivedAt >= cutoff)
  }
}
