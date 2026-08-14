/**
 * 재전송 방지 — 브릿지가 강제한다
 *
 * 설계 근거는 docs/architecture.md §10.5.
 *
 * 릴레이 측 재전송 방지는 보안 연극이다 — 재전송할 수 있는 공격자가
 * 릴레이 자신인 경우가 많다. 브릿지가 신뢰 경계이고 로컬 상태를 가지므로
 * 여기서 판정한다.
 *
 * 이 모듈은 복호화를 하지 않는다. 평문 헤더만 보고 판정하는 것이 요점이다 —
 * 재전송 폭주가 X25519 언랩에 닿기 전에 여기서 죽어야 한다 (§10.5 4항).
 * AAD 결속(§10.5 1항) 덕분에 헤더의 seq·timestamp 는 위조하면 나중에
 * 복호화가 깨지므로, 이 싼 검사를 먼저 신뢰해도 된다.
 */
import type { Header } from './envelope.ts'

/** 슬라이딩 윈도우 폭. IPsec 권고(RFC 4303 §3.4.3)와 같은 1024비트. */
export const WINDOW_BITS = 1024

/** 신선도 윈도우 ±5분. dedup 캐시를 유한하게 유지하는 것이 목적이다. */
export const FRESHNESS_MS = 5 * 60 * 1000

/** 판정 결과. 거부 사유를 구분하는 이유는 §10.5 3항 — 시계 오차를 로깅해야 한다. */
export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason; readonly detail: string }

export type Reason =
  /** 신선도 윈도우 밖. 시계 오차일 수 있으므로 별도 사유로 둔다. */
  | 'stale'
  | 'future'
  /** seq 가 윈도우 아래로 떨어졌다 — 너무 오래된 재전송. */
  | 'window'
  /** 이미 본 seq. */
  | 'replayed'
  /** 이미 본 message id. */
  | 'duplicate'

/**
 * 발신자 한 명분 슬라이딩 윈도우.
 *
 * high-water-mark(가장 높이 본 seq) + 그 아래 1024개 슬롯의 비트맵.
 * 비트맵은 순환 버퍼로 두고 시프트 대신 마스킹으로 접근한다 —
 * seq 가 크게 뛰어도 O(1) 이다.
 */
class Window {
  /** 아직 아무것도 받지 않았음을 -1n 로 표시한다. seq 0 이 유효하기 때문. */
  private high = -1n
  private readonly bits = new Uint32Array(WINDOW_BITS / 32)

  /** 판정만 한다. 상태를 바꾸지 않는다. */
  check(seq: bigint): Verdict {
    if (seq < 0n) return no('window', `seq 가 음수다 (${seq})`)
    if (this.high < 0n) return YES
    if (seq > this.high) return YES

    const behind = this.high - seq
    if (behind >= BigInt(WINDOW_BITS)) {
      return no('window', `seq ${seq} 가 윈도우 밖이다 (최신 ${this.high}, 폭 ${WINDOW_BITS})`)
    }
    if (this.get(seq)) return no('replayed', `seq ${seq} 는 이미 받았다`)
    return YES
  }

  /** 수용을 기록한다. check 가 통과한 뒤에만 부른다. */
  accept(seq: bigint): void {
    if (seq > this.high) {
      // 새 high-water-mark. 사이에 뛰어넘은 슬롯들을 비운다 —
      // 순환 버퍼라 예전 값이 남아 있으면 미래 seq 를 재전송으로 오판한다.
      const from = this.high < 0n ? seq : this.high + 1n
      const span = seq - from
      if (span >= BigInt(WINDOW_BITS)) {
        this.bits.fill(0)
      } else {
        for (let s = from; s < seq; s++) this.clear(s)
      }
      this.high = seq
    }
    this.set(seq)
  }

  private slot(seq: bigint): [index: number, mask: number] {
    const bit = Number(seq % BigInt(WINDOW_BITS))
    return [bit >>> 5, 1 << (bit & 31)]
  }

  private get(seq: bigint): boolean {
    const [i, m] = this.slot(seq)
    return (this.bits[i]! & m) !== 0
  }

  private set(seq: bigint): void {
    const [i, m] = this.slot(seq)
    this.bits[i] = this.bits[i]! | m
  }

  private clear(seq: bigint): void {
    const [i, m] = this.slot(seq)
    this.bits[i] = this.bits[i]! & ~m
  }
}

const YES: Verdict = { ok: true }
const no = (reason: Reason, detail: string): Verdict => ({ ok: false, reason, detail })

export interface GuardOptions {
  /** 신선도 윈도우 반폭(ms). 기본 ±5분. */
  readonly freshnessMs?: number
  /** 현재 시각. 테스트에서만 주입한다. */
  readonly now?: () => number
}

/**
 * 채널 하나의 재전송 방지 상태.
 *
 * 채널마다 인스턴스를 둔다 — 채널 태그가 AAD 에 있으므로 채널 간 전용은
 * 복호화 단계에서 이미 막히지만, seq 공간을 채널별로 분리해야 한 채널의
 * 활동이 다른 채널의 윈도우를 밀어내지 않는다.
 */
export class ReplayGuard {
  private readonly windows = new Map<string, Window>()
  /** message id → 만료 시각(ms). 신선도 윈도우 밖이면 지운다. */
  private readonly seen = new Map<string, number>()
  private readonly freshnessMs: number
  private readonly now: () => number

  constructor(options: GuardOptions = {}) {
    this.freshnessMs = options.freshnessMs ?? FRESHNESS_MS
    this.now = options.now ?? Date.now
  }

  /**
   * 헤더를 검사하고, 통과하면 수용을 기록한다.
   *
   * 검사 순서가 §10.5 4항이다 — 싼 것부터. 신선도(정수 비교) →
   * seq 윈도우(비트 연산) → dedup(해시 조회). 전부 대칭 연산이고,
   * 호출자는 이게 통과한 뒤에야 비대칭 언랩으로 넘어간다.
   */
  admit(header: Header): Verdict {
    const fresh = this.checkFreshness(header.timestamp)
    if (!fresh.ok) return fresh

    const sender = hex(header.senderKeyId)
    const window = this.windows.get(sender) ?? new Window()
    const seq = window.check(header.seq)
    if (!seq.ok) return seq

    const id = hex(header.messageId)
    if (this.seen.has(id)) return no('duplicate', `message id ${id} 는 이미 받았다`)

    // 여기서부터 상태를 바꾼다. 위의 어느 검사든 실패하면 아무것도 안 바뀐다.
    window.accept(header.seq)
    this.windows.set(sender, window)
    this.seen.set(id, Number(header.timestamp) + this.freshnessMs)
    this.sweep()
    return YES
  }

  /** 상태를 바꾸지 않는 검사. 로깅·진단용. */
  peek(header: Header): Verdict {
    const fresh = this.checkFreshness(header.timestamp)
    if (!fresh.ok) return fresh
    const window = this.windows.get(hex(header.senderKeyId))
    const seq = window ? window.check(header.seq) : YES
    if (!seq.ok) return seq
    const id = hex(header.messageId)
    return this.seen.has(id) ? no('duplicate', `message id ${id} 는 이미 받았다`) : YES
  }

  /** 추적 중인 발신자 수. 진단용. */
  get senderCount(): number {
    return this.windows.size
  }

  /** dedup 캐시 크기. 신선도 윈도우가 유한하게 유지하는지 보는 용도. */
  get cacheSize(): number {
    return this.seen.size
  }

  private checkFreshness(timestamp: bigint): Verdict {
    const skew = Number(timestamp) - this.now()
    if (skew < -this.freshnessMs) {
      return no('stale', `${-skew}ms 오래됐다 (허용 ${this.freshnessMs}ms) — 시계 오차일 수 있다`)
    }
    if (skew > this.freshnessMs) {
      return no('future', `${skew}ms 미래다 (허용 ${this.freshnessMs}ms) — 시계 오차일 수 있다`)
    }
    return YES
  }

  /**
   * 만료된 dedup 항목을 지운다.
   *
   * 신선도 윈도우가 이미 오래된 메시지를 막으므로, 만료된 id 를 지워도
   * 재전송이 뚫리지 않는다 — 그 재전송은 'stale' 로 먼저 걸린다.
   */
  private sweep(): void {
    const now = this.now()
    for (const [id, expires] of this.seen) {
      if (expires < now) this.seen.delete(id)
    }
  }
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
