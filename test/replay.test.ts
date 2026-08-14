/**
 * 재전송 방지 테스트
 *
 * 순환 비트맵은 조용히 틀리는 종류의 코드다 — 정상 흐름은 잘 돌면서
 * seq 가 윈도우를 한 바퀴 넘을 때만 깨진다. 그 경계가 이 파일의 본론이다.
 */
import { test, expect, describe } from 'bun:test'
import { ReplayGuard, WINDOW_BITS, FRESHNESS_MS } from '../src/crypto/replay.ts'
import type { Header } from '../src/crypto/envelope.ts'

const SENDER_A = new Uint8Array(8).fill(0xaa)
const SENDER_B = new Uint8Array(8).fill(0xbb)
const TAG = new Uint8Array(16).fill(0xcd)

/** 고정 시각. 실제 시계에 의존하면 테스트가 시간에 따라 흔들린다. */
const NOW = 1_700_000_000_000
const at = () => NOW

let counter = 0
function header(over: Partial<Header> = {}): Header {
  return {
    channelTag: TAG,
    messageId: idOf(++counter),
    senderKeyId: SENDER_A,
    seq: 0n,
    timestamp: BigInt(NOW),
    nonce: new Uint8Array(24),
    ...over,
  }
}

function idOf(n: number): Uint8Array {
  const out = new Uint8Array(16)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

const guard = () => new ReplayGuard({ now: at })

describe('정상 흐름', () => {
  test('순차 seq 를 전부 받는다', () => {
    const g = guard()
    for (let i = 0; i < 100; i++) {
      expect(g.admit(header({ seq: BigInt(i) })).ok).toBe(true)
    }
  })

  test('seq 0 을 받는다 — 첫 메시지가 거부되지 않는다', () => {
    // high-water-mark 를 0 으로 초기화하면 첫 메시지가 재전송으로 걸린다.
    expect(guard().admit(header({ seq: 0n })).ok).toBe(true)
  })

  test('건너뛴 seq 를 나중에 받는다 — 순서 뒤바뀜 허용', () => {
    const g = guard()
    expect(g.admit(header({ seq: 10n })).ok).toBe(true)
    expect(g.admit(header({ seq: 7n })).ok).toBe(true)
    expect(g.admit(header({ seq: 9n })).ok).toBe(true)
    expect(g.admit(header({ seq: 8n })).ok).toBe(true)
  })

  test('발신자마다 seq 공간이 분리된다', () => {
    const g = guard()
    expect(g.admit(header({ seq: 5n, senderKeyId: SENDER_A })).ok).toBe(true)
    // B 의 seq 5 는 A 와 무관하다.
    expect(g.admit(header({ seq: 5n, senderKeyId: SENDER_B })).ok).toBe(true)
    expect(g.senderCount).toBe(2)
  })
})

describe('재전송 거부', () => {
  test('같은 seq 를 두 번 받지 않는다', () => {
    const g = guard()
    expect(g.admit(header({ seq: 3n })).ok).toBe(true)
    const again = g.admit(header({ seq: 3n }))
    expect(again.ok).toBe(false)
    expect(again).toMatchObject({ reason: 'replayed' })
  })

  test('같은 message id 를 두 번 받지 않는다', () => {
    const g = guard()
    const id = idOf(999)
    expect(g.admit(header({ seq: 1n, messageId: id })).ok).toBe(true)
    // seq 는 새것이지만 id 가 같다 — 프레이밍을 바꾼 재전송.
    const again = g.admit(header({ seq: 2n, messageId: id }))
    expect(again.ok).toBe(false)
    expect(again).toMatchObject({ reason: 'duplicate' })
  })

  test('윈도우 아래로 떨어진 seq 를 거부한다', () => {
    const g = guard()
    expect(g.admit(header({ seq: BigInt(WINDOW_BITS + 100) })).ok).toBe(true)
    const old = g.admit(header({ seq: 5n }))
    expect(old.ok).toBe(false)
    expect(old).toMatchObject({ reason: 'window' })
  })

  test('윈도우 경계 바로 안쪽은 받는다', () => {
    const g = guard()
    const high = BigInt(WINDOW_BITS + 100)
    expect(g.admit(header({ seq: high })).ok).toBe(true)
    // high - (WINDOW_BITS - 1) 은 아직 윈도우 안이다.
    expect(g.admit(header({ seq: high - BigInt(WINDOW_BITS - 1) })).ok).toBe(true)
    // 한 칸 더 아래는 밖이다.
    expect(g.admit(header({ seq: high - BigInt(WINDOW_BITS) })).ok).toBe(false)
  })

  test('음수 seq 를 거부한다', () => {
    expect(guard().admit(header({ seq: -1n })).ok).toBe(false)
  })
})

describe('순환 버퍼 경계 — 조용히 깨지는 자리', () => {
  test('윈도우를 한 바퀴 넘어도 옛 비트를 재전송으로 오판하지 않는다', () => {
    const g = guard()
    // seq 5 를 받아 비트를 켜 둔다.
    expect(g.admit(header({ seq: 5n })).ok).toBe(true)
    // 정확히 한 바퀴 뒤의 seq 는 같은 슬롯을 쓴다. 시프트를 안 하면
    // 켜져 있는 옛 비트 때문에 새 메시지가 재전송으로 걸린다.
    expect(g.admit(header({ seq: BigInt(WINDOW_BITS + 5) })).ok).toBe(true)
  })

  test('크게 뛴 뒤 사이 구간이 비어 있다', () => {
    const g = guard()
    expect(g.admit(header({ seq: 1n })).ok).toBe(true)
    // 세 바퀴 넘게 점프 — 비트맵 전체가 비워져야 한다.
    const far = BigInt(WINDOW_BITS * 3 + 7)
    expect(g.admit(header({ seq: far })).ok).toBe(true)
    // 새 윈도우 안의 아무 seq 나 처음 받는 것으로 취급돼야 한다.
    for (const back of [1n, 2n, 500n, BigInt(WINDOW_BITS - 1)]) {
      expect(g.admit(header({ seq: far - back })).ok).toBe(true)
    }
  })

  test('작게 뛴 뒤 사이 구간이 비어 있다', () => {
    const g = guard()
    // 3 을 받아 두면 슬롯 3 이 켜진다.
    expect(g.admit(header({ seq: 3n })).ok).toBe(true)
    // WINDOW_BITS 만큼 뛰면 3 은 윈도우 밖으로 나가고,
    // 그 사이 4..WINDOW_BITS+2 는 비어야 한다.
    const next = BigInt(WINDOW_BITS + 3)
    expect(g.admit(header({ seq: next })).ok).toBe(true)
    expect(g.admit(header({ seq: next - 1n })).ok).toBe(true)
    expect(g.admit(header({ seq: BigInt(WINDOW_BITS) })).ok).toBe(true)
  })

  test('한 바퀴 뒤에도 진짜 재전송은 걸린다', () => {
    const g = guard()
    const s = BigInt(WINDOW_BITS + 5)
    expect(g.admit(header({ seq: s })).ok).toBe(true)
    expect(g.admit(header({ seq: s })).ok).toBe(false)
  })
})

describe('신선도 윈도우', () => {
  test('오래된 메시지를 거부한다', () => {
    const g = guard()
    const v = g.admit(header({ timestamp: BigInt(NOW - FRESHNESS_MS - 1000) }))
    expect(v.ok).toBe(false)
    expect(v).toMatchObject({ reason: 'stale' })
  })

  test('미래 메시지를 거부한다', () => {
    const g = guard()
    const v = g.admit(header({ timestamp: BigInt(NOW + FRESHNESS_MS + 1000) }))
    expect(v.ok).toBe(false)
    expect(v).toMatchObject({ reason: 'future' })
  })

  test('시계 오차를 사유에 밝힌다 — 진단 가능해야 한다', () => {
    const g = guard()
    const v = g.admit(header({ timestamp: BigInt(NOW - FRESHNESS_MS - 1) }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.detail).toContain('시계 오차')
  })

  test('윈도우 안이면 앞뒤로 다 받는다', () => {
    const g = guard()
    expect(g.admit(header({ seq: 1n, timestamp: BigInt(NOW - FRESHNESS_MS + 1) })).ok).toBe(true)
    expect(g.admit(header({ seq: 2n, timestamp: BigInt(NOW + FRESHNESS_MS - 1) })).ok).toBe(true)
  })

  test('신선도 실패는 상태를 바꾸지 않는다', () => {
    const g = guard()
    expect(g.admit(header({ seq: 7n, timestamp: 0n })).ok).toBe(false)
    expect(g.senderCount).toBe(0)
    expect(g.cacheSize).toBe(0)
    // 같은 seq 를 제대로 된 시각으로 다시 보내면 받아야 한다.
    expect(g.admit(header({ seq: 7n })).ok).toBe(true)
  })
})

describe('캐시 유한성', () => {
  test('만료된 dedup 항목이 정리된다', () => {
    let clock = NOW
    const g = new ReplayGuard({ now: () => clock })
    for (let i = 0; i < 50; i++) {
      g.admit(header({ seq: BigInt(i), timestamp: BigInt(clock) }))
    }
    expect(g.cacheSize).toBe(50)

    // 신선도 윈도우를 넘겨 시간을 진행시킨다.
    clock = NOW + FRESHNESS_MS * 3
    g.admit(header({ seq: 100n, timestamp: BigInt(clock) }))
    // 옛 항목은 정리되고 방금 것만 남는다.
    expect(g.cacheSize).toBe(1)
  })

  test('정리 후에도 옛 메시지는 신선도로 막힌다', () => {
    // dedup 항목이 지워져도 재전송이 뚫리지 않아야 한다 —
    // 그 재전송은 'stale' 로 먼저 걸린다.
    let clock = NOW
    const g = new ReplayGuard({ now: () => clock })
    const old = header({ seq: 1n, timestamp: BigInt(clock) })
    expect(g.admit(old).ok).toBe(true)

    clock = NOW + FRESHNESS_MS * 3
    g.admit(header({ seq: 100n, timestamp: BigInt(clock) }))
    expect(g.cacheSize).toBe(1)

    const replayed = g.admit(old)
    expect(replayed.ok).toBe(false)
    expect(replayed).toMatchObject({ reason: 'stale' })
  })
})

describe('peek — 상태를 바꾸지 않는 검사', () => {
  test('peek 은 수용을 기록하지 않는다', () => {
    const g = guard()
    const h = header({ seq: 1n })
    expect(g.peek(h).ok).toBe(true)
    expect(g.peek(h).ok).toBe(true)
    expect(g.senderCount).toBe(0)
    // 실제 수용은 여전히 가능하다.
    expect(g.admit(h).ok).toBe(true)
  })

  test('peek 이 admit 과 같은 판정을 낸다', () => {
    const g = guard()
    const h = header({ seq: 1n })
    g.admit(h)
    expect(g.peek(h)).toMatchObject({ ok: false, reason: 'replayed' })
  })
})

describe('검사 순서 — §10.5 4항', () => {
  test('신선도가 seq 보다 먼저다', () => {
    const g = guard()
    // seq 가 재전송이면서 동시에 오래된 메시지. 싼 검사(신선도)가 먼저 걸려야 한다.
    g.admit(header({ seq: 1n }))
    const v = g.admit(header({ seq: 1n, timestamp: 0n }))
    expect(v).toMatchObject({ ok: false, reason: 'stale' })
  })

  test('seq 가 dedup 보다 먼저다', () => {
    const g = guard()
    const id = idOf(4242)
    g.admit(header({ seq: 1n, messageId: id }))
    // seq 도 재전송이고 id 도 중복. 비트 연산(seq)이 해시 조회(dedup)보다 먼저다.
    const v = g.admit(header({ seq: 1n, messageId: id }))
    expect(v).toMatchObject({ ok: false, reason: 'replayed' })
  })
})
