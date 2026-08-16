/**
 * 수신 경로 — 검사 순서를 코드로 강제한다
 *
 * 설계 근거는 docs/architecture.md §10.5.
 *
 * `open()` 과 `ReplayGuard` 를 따로 두면 호출자가 순서를 틀릴 수 있다.
 * 재전송 방지를 언랩 뒤에 부르면 검사는 다 통과하면서 §10.5 4항이
 * 약속한 성질(재전송 폭주가 X25519 를 소모하지 않는다)만 조용히 사라진다.
 * 그래서 순서를 호출자 재량으로 남기지 않고 여기 한 곳에 고정한다.
 *
 * 순서: 구조 → 서명 → 신선도·seq·dedup → 비대칭 언랩 → 본문 복호.
 */
import type { Identity } from '../identity/keys.js'
import { verify } from '../identity/keys.js'
import { type Envelope, decode, signingBytes } from './envelope.js'
import { open } from './seal.js'
import type { ReplayGuard, Reason } from './replay.js'

/** 거부 사유. 재전송 사유에 서명·구조·발신자 미상을 더한 것. */
export type RejectReason = Reason | 'malformed' | 'signature' | 'unknown-sender' | 'not-recipient'

export type Received =
  | { readonly ok: true; readonly envelope: Envelope; readonly plaintext: Uint8Array }
  | { readonly ok: false; readonly reason: RejectReason; readonly detail: string }

export interface ReceiveInput {
  /** 릴레이에서 받은 전송 바이트, 또는 이미 디코딩된 봉투. */
  readonly wire: Uint8Array | Envelope
  readonly recipient: Identity
  readonly guard: ReplayGuard
  /**
   * 발신자 key id → Ed25519 공개키 조회.
   *
   * 신뢰 목록은 이 모듈 밖에 있다 — 여기서 결정할 일이 아니다.
   * 모르는 발신자는 undefined 를 주면 된다.
   */
  readonly lookupSender: (keyId: Uint8Array) => Uint8Array | undefined
}

/**
 * 봉투 하나를 수신한다.
 *
 * 성공했을 때만 재전송 상태가 갱신된다 — 서명이 깨진 봉투가 seq 를
 * 선점해 정상 메시지를 막는 일이 없어야 한다. 그래서 guard.admit 은
 * 서명 검증 뒤에 온다.
 */
export async function receive(input: ReceiveInput): Promise<Received> {
  const { recipient, guard, lookupSender } = input

  // 1. 구조 — 가장 싸다. 파싱조차 안 되는 것을 먼저 버린다.
  let envelope: Envelope
  try {
    envelope = input.wire instanceof Uint8Array ? decode(input.wire) : input.wire
  } catch (e) {
    return no('malformed', e instanceof Error ? e.message : String(e))
  }

  const { header, keys, body, signature } = envelope

  // 2. 발신자를 아는가. 조회는 해시 한 번이다.
  const senderKey = lookupSender(header.senderKeyId)
  if (!senderKey) {
    return no('unknown-sender', `모르는 발신자다: ${hex(header.senderKeyId)}`)
  }

  // 3. 서명 — 대칭 연산. 여기를 통과해야 헤더 값을 믿고 상태를 갱신한다.
  if (!verify(senderKey, signingBytes(header, keys, body), signature)) {
    return no('signature', '발신자 서명이 유효하지 않다')
  }

  // 4. 신선도 → seq 윈도우 → dedup. 전부 대칭이고, 비대칭 언랩 앞이다.
  const verdict = guard.admit(header)
  if (!verdict.ok) return no(verdict.reason, verdict.detail)

  // 5. 비대칭 언랩 + 본문 복호. 가장 비싸다.
  try {
    const plaintext = await open({ envelope, recipient, senderSignPublicKey: senderKey })
    return { ok: true, envelope, plaintext }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return no(detail.includes('수신자가 아니다') ? 'not-recipient' : 'malformed', detail)
  }
}

const no = (reason: RejectReason, detail: string): Received => ({ ok: false, reason, detail })

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
