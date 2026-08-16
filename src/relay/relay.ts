/**
 * 릴레이 — 암호문을 받아 수신자 큐에 넣는다
 *
 * 설계 근거는 docs/architecture.md §릴레이 · §10.7.
 *
 * 릴레이는 신뢰 대상이 **아니다**. 그래서 여기서 하지 않는 것이 하는 것보다
 * 중요하다:
 *
 * - 복호화하지 않는다. 콘텐츠 키를 풀 개인키가 없다.
 * - 서명을 검증하지 않는다. 신뢰 목록은 브릿지에 있다 (§8).
 * - 재전송을 막지 않는다. 재전송할 수 있는 공격자가 릴레이 자신인 경우가
 *   많으므로 릴레이 측 재전송 방지는 보안 연극이다 (§10.5).
 * - 배달을 확인하지 않는다. 그걸 추적하면 더 이상 무상태가 아니다.
 *
 * 하는 것은 하나다 — **봉투의 수신자 key id 를 읽어 그 큐에 넣는다.**
 * 그 key id 는 평문 헤더에 있고(§10.6), 그것이 릴레이가 라우팅에
 * 필요한 전부다.
 */
import { decode, MAX_BODY_BYTES, MAX_RECIPIENTS } from '../crypto/envelope.js'
import type { Store, Stored } from './store.js'

/** 봉투 하나의 전송 크기 상한. 본문 상한 + 최대 팬아웃 오버헤드에 여유. */
export const MAX_ENVELOPE_BYTES = MAX_BODY_BYTES + 64 * 1024

/** 한 번의 폴링으로 가져갈 수 있는 최대 개수. */
export const DEFAULT_DRAIN_LIMIT = 100

export type PostResult =
  | { readonly ok: true; readonly recipients: number; readonly messageId: string }
  | { readonly ok: false; readonly reason: PostReason; readonly detail: string }

export type PostReason =
  /** 봉투 형식이 아니거나 잘렸다. */
  | 'malformed'
  /** 크기 상한 초과. */
  | 'too-large'
  /** 수신자가 없다 — 배달할 곳이 없는 봉투. */
  | 'no-recipients'

export interface RelayOptions {
  readonly store: Store
  readonly maxEnvelopeBytes?: number
  readonly drainLimit?: number
  /** 현재 시각. 테스트에서만 주입한다. */
  readonly now?: () => number
}

/**
 * 릴레이.
 *
 * HTTP 계층과 분리해 둔다 — 서버리스 함수든 로컬 서버든 같은 로직을
 * 쓰고, 테스트에 HTTP 가 필요 없다.
 */
export class Relay {
  private readonly store: Store
  private readonly maxBytes: number
  private readonly drainLimit: number
  private readonly now: () => number

  constructor(options: RelayOptions) {
    this.store = options.store
    this.maxBytes = options.maxEnvelopeBytes ?? MAX_ENVELOPE_BYTES
    this.drainLimit = options.drainLimit ?? DEFAULT_DRAIN_LIMIT
    this.now = options.now ?? Date.now
  }

  /**
   * 봉투를 받아 수신자별 큐에 넣는다.
   *
   * 크기 검사가 파싱보다 먼저다 — 거대한 입력을 파싱하는 것 자체가
   * 비용이고, 그게 릴레이에 대한 가장 싼 공격이다.
   */
  async post(wire: Uint8Array): Promise<PostResult> {
    if (wire.length > this.maxBytes) {
      return no('too-large', `봉투가 너무 크다 (${wire.length}B > ${this.maxBytes}B)`)
    }

    // 구조 검사만 한다. 복호화도 서명 검증도 하지 않는다 — 할 수 없고,
    // 해서도 안 된다. 여기서 보는 것은 "어디로 보낼지"뿐이다.
    let header, keys
    try {
      const envelope = decode(wire)
      header = envelope.header
      keys = envelope.keys
    } catch (e) {
      return no('malformed', e instanceof Error ? e.message : String(e))
    }

    if (keys.length === 0) return no('no-recipients', '수신자가 없는 봉투다')
    if (keys.length > MAX_RECIPIENTS) {
      return no('malformed', `수신자가 너무 많다 (${keys.length})`)
    }

    // 같은 blob 을 수신자 수만큼 넣는다. 봉투 하나에 모두의 래핑 키가
    // 들어 있으므로 수신자별로 자를 필요가 없다 (§10.3).
    const item: Stored = { envelope: wire, receivedAt: this.now() }
    await Promise.all(keys.map(k => this.store.push(hex(k.keyId), item)))

    return { ok: true, recipients: keys.length, messageId: hex(header.messageId) }
  }

  /**
   * 수신자 큐를 비우며 가져간다.
   *
   * **여기서 인증하지 않는다.** 폴링 인증(§10.12)은 HTTP 계층의 책임이다 —
   * 인증 재료가 요청 헤더로 오기 때문이다. 이 메서드에 닿았다는 것은
   * 이미 검증을 통과했다는 뜻이므로, 호출자는 반드시 그 순서를 지킨다.
   */
  async fetch(recipientKeyId: string, limit?: number): Promise<Stored[]> {
    const n = Math.min(limit ?? this.drainLimit, this.drainLimit)
    return this.store.drain(normalize(recipientKeyId), n)
  }

  /** 대기 중인 항목 수. 진단용. */
  async depth(recipientKeyId: string): Promise<number> {
    return this.store.depth(normalize(recipientKeyId))
  }
}

const no = (reason: PostReason, detail: string): PostResult => ({ ok: false, reason, detail })

/** key id 표기를 통일한다 — 대문자 hex 로 넣고 소문자로 찾는 일이 없게. */
function normalize(keyId: string): string {
  return keyId.toLowerCase()
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
