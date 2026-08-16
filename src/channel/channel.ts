/**
 * 채널 — 참여 노드의 집합
 *
 * 설계 근거는 docs/architecture.md §5 · §8 · §10.11.
 *
 * 채팅방은 별도 기능이 아니다. 2명이면 1:1, N명이면 팀 룸 — 같은 구조다.
 * 그룹 키가 없으므로 멤버 변경에 회전할 것이 없고, 멤버 목록이 곧
 * 다음 메시지의 수신자 목록이다 (§10.3).
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { fingerprint, toHex } from '../identity/fingerprint.js'
// 파생 소유자는 신원 모듈이다 — 채널이 key id 하나 때문에 암호 모듈을 거칠 이유가 없다.
import { keyIdOf } from '../identity/keys.js'
import { CHANNEL_TAG_BYTES, MAX_RECIPIENTS } from '../crypto/envelope.js'

/** 채널 비밀 32B. 멤버만 안다 — 초대는 이 비밀을 전달하는 것이다 (§10.11). */
export const CHANNEL_SECRET_BYTES = 32

const TAG_LABEL = new TextEncoder().encode('agent-channel-mesh/v1/channel-tag')

/**
 * 채널 태그를 파생한다 (§10.11).
 *
 * v1 의 epoch 는 0 고정이라 태그는 채널당 상수다. 회전은 epoch 를 올리는
 * 것뿐이며 봉투 형식도 멤버십도 바뀌지 않는다. 채널 id 를 그대로 태그로
 * 쓰면 회전할 방법이 없어지므로 파생을 처음부터 끼워 둔다.
 */
export function deriveTag(secret: Uint8Array, epoch = 0): Uint8Array {
  if (secret.length !== CHANNEL_SECRET_BYTES) {
    throw new Error(`채널 비밀은 ${CHANNEL_SECRET_BYTES}바이트여야 한다 (받은 값: ${secret.length})`)
  }
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`epoch 가 올바르지 않다 (${epoch})`)

  const input = new Uint8Array(TAG_LABEL.length + 8)
  input.set(TAG_LABEL, 0)
  new DataView(input.buffer).setBigUint64(TAG_LABEL.length, BigInt(epoch), false)
  return hmac(sha256, secret, input).slice(0, CHANNEL_TAG_BYTES)
}

/**
 * 채널 멤버.
 *
 * 신원 자체가 아니라 그 공개 부분만 담는다 — 멤버 목록은 다른 노드에서
 * 받아 오는 것이라 개인키가 있을 수 없다.
 */
export interface Member {
  /** Ed25519 서명 공개키. 진정성 검증용. */
  readonly signPublicKey: Uint8Array
  /** X25519 KEM 공개키. 콘텐츠 키 래핑용. */
  readonly kemPublicKey: Uint8Array
  /** 사람이 부르는 이름. 신뢰의 근거가 아니다 — 근거는 지문뿐이다. */
  readonly label?: string
}

/** 검증된 멤버 — 지문·key id 가 계산돼 있다. */
export interface ResolvedMember extends Member {
  /** 128비트 지문 (§9). 사람이 대조하는 값. */
  readonly fingerprint: Uint8Array
  /** key id 8B — 두 공개키에서 함께 파생한다 (§10.12). 봉투에서 자기 몫을 찾는 값. */
  readonly keyId: Uint8Array
}

export interface ChannelInit {
  /** 채널 비밀. 없으면 새로 만든다(= 채널 생성). */
  readonly secret?: Uint8Array
  /** 사람이 읽는 채널 이름. 라우팅에 쓰이지 않는다. */
  readonly name?: string
  readonly epoch?: number
}

/**
 * 채널 상태.
 *
 * 이 객체는 **로컬 뷰**다. 릴레이에 정본 멤버 목록이 있는 것이 아니라,
 * 각 노드가 자기가 아는 멤버를 들고 있다. 릴레이는 신뢰 대상이 아니므로
 * (§10.5) 멤버십을 릴레이에 맡길 수 없다.
 */
export class Channel {
  readonly secret: Uint8Array
  readonly tag: Uint8Array
  readonly epoch: number
  readonly name: string
  /** key id hex → 멤버. key id 로 조회하는 것이 수신 경로의 요구다. */
  private readonly members = new Map<string, ResolvedMember>()

  constructor(init: ChannelInit = {}) {
    const secret = init.secret ?? randomBytes(CHANNEL_SECRET_BYTES)
    if (secret.length !== CHANNEL_SECRET_BYTES) {
      throw new Error(`채널 비밀은 ${CHANNEL_SECRET_BYTES}바이트여야 한다 (받은 값: ${secret.length})`)
    }
    this.secret = secret
    this.epoch = init.epoch ?? 0
    this.tag = deriveTag(secret, this.epoch)
    this.name = init.name ?? ''
  }

  /**
   * 멤버를 추가한다 (§8).
   *
   * **허용목록에 넣는 것은 권한을 주는 것이다.** 권한 중계를 켜면 이 멤버가
   * 내 세션의 도구 사용을 승인·거부할 수 있다. 호출자는 지문을 사람이
   * 대조한 뒤에만 이걸 불러야 한다.
   *
   * key id 가 두 공개키에서 함께 나오므로(§10.12) "같은 key id, 다른 서명키"는
   * 더 이상 충돌하지 않는다. 그 대신 **한쪽 키만 갈아 끼운 등록**을 직접
   * 막는다 — 그러지 않으면 조용히 별도 멤버로 들어앉아 사칭이 통과한다.
   * 한 번의 스캔으로 양방향을 본다: 멤버 수가 MAX_RECIPIENTS 로 묶여 있고
   * 추가는 사람이 지문을 대조한 뒤에만 일어나므로, 보조 색인을 따로 두어
   * `remove()` 와 어긋날 여지를 만드는 것보다 이쪽이 안전하다.
   */
  add(member: Member): ResolvedMember {
    if (member.signPublicKey.length !== 32) throw new Error('서명 공개키는 32바이트여야 한다')
    if (member.kemPublicKey.length !== 32) throw new Error('KEM 공개키는 32바이트여야 한다')

    const keyId = keyIdOf(member.kemPublicKey, member.signPublicKey)
    const key = toKey(keyId)
    // 두 키가 모두 같으면 같은 멤버다 — 멱등하게 기존 것을 돌려준다.
    const existing = this.members.get(key)
    if (existing) return existing

    for (const m of this.members.values()) {
      // 같은 KEM 키에 다른 서명키가 오면 키 교체 시도다. 조용히 별도
      // 멤버로 넣으면 사칭이 통과하므로 거부하고 사람에게 넘긴다.
      if (equal(m.kemPublicKey, member.kemPublicKey)) {
        throw new Error(
          `이미 다른 서명키로 등록된 KEM 공개키다: ${toHex(member.kemPublicKey)} — 사람이 지문을 다시 대조해야 한다`,
        )
      }
      // 같은 불변식의 더 강한 형태. 사람이 대조하는 지문은 서명키에서만
      // 나오므로(identity/fingerprint), 검증된 서명키에 KEM 키만 바꿔 단
      // 항목은 신뢰된 지문을 그대로 띄우면서 본문은 공격자 KEM 키로 감싸게
      // 만든다. 지문이 맞아 보이는 만큼 더 위험하다.
      if (equal(m.signPublicKey, member.signPublicKey)) {
        throw new Error(
          `이미 다른 KEM 키로 등록된 서명키다: ${toHex(member.signPublicKey)} — 사람이 지문을 다시 대조해야 한다`,
        )
      }
    }

    if (this.members.size >= MAX_RECIPIENTS) {
      throw new Error(`멤버가 너무 많다 (상한 ${MAX_RECIPIENTS})`)
    }

    const resolved: ResolvedMember = {
      ...member,
      keyId,
      fingerprint: fingerprint(member.signPublicKey),
    }
    this.members.set(key, resolved)
    return resolved
  }

  /**
   * 멤버를 제거한다.
   *
   * 회전할 그룹 키가 없다 (§10.3). 제거는 다음 메시지의 수신자 목록에서
   * 빠지는 것이고, 그것으로 충분하다 — 나간 멤버가 채널 비밀을 기억해도
   * 자기 몫의 래핑 키가 없어 읽지 못한다 (§10.11).
   *
   * 이미 받은 메시지는 여전히 읽을 수 있다. 순방향 비밀성이 없다는
   * §10.4 의 정직한 서술이 여기에도 그대로 적용된다.
   */
  remove(keyId: Uint8Array): boolean {
    return this.members.delete(toKey(keyId))
  }

  has(keyId: Uint8Array): boolean {
    return this.members.has(toKey(keyId))
  }

  get(keyId: Uint8Array): ResolvedMember | undefined {
    return this.members.get(toKey(keyId))
  }

  /** 멤버 목록. 삽입 순서를 유지한다. */
  list(): ResolvedMember[] {
    return [...this.members.values()]
  }

  get size(): number {
    return this.members.size
  }

  /**
   * 나를 뺀 수신자 목록 — `seal()` 에 그대로 넘긴다.
   *
   * 자기 자신에게 보내지 않는 것은 에코 억제(§7)의 가장 아래층이다.
   *
   * 멤버를 그대로 넘긴다 — key id 가 두 공개키에서 나오므로(§10.12) 서명키를
   * 떼어 내면 `seal()` 이 다른 key id 를 계산하고, 봉투는 아무도 열 수 없는
   * 몫만 담게 된다. `ResolvedMember` 는 `Recipient` 를 구조적으로 만족한다.
   */
  recipients(self: Uint8Array): ResolvedMember[] {
    const me = toKey(self)
    return [...this.members.values()].filter(m => toKey(m.keyId) !== me)
  }

  /**
   * 발신자 서명키 조회 — `receive()` 의 `lookupSender` 에 그대로 넘긴다.
   *
   * 멤버가 아니면 undefined 다. 허용목록에 없는 발신자의 메시지는
   * 버려진다 (§8).
   */
  readonly lookupSender = (keyId: Uint8Array): Uint8Array | undefined =>
    this.members.get(toKey(keyId))?.signPublicKey
}

function toKey(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
