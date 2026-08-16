/**
 * 공개값만 다루는 신원 연산 — key id 파생과 서명 검증
 *
 * 설계 근거는 docs/architecture.md §10.2 · §10.12.
 *
 * **왜 `keys.ts` 에서 갈라 뒀는가**: 릴레이가 서명된 수신함 폴링(§10.12)을
 * 검증하려면 `keyIdOf` 와 `verify` 가 필요하다. 그런데 `keys.ts` 는 최상위에서
 * `new DhkemX25519HkdfSha256()` 를 실행하고 `./fingerprint.ts`(워드리스트)를
 * 끌고 온다. 릴레이는 HPKE 도 워드리스트도 전혀 쓰지 않으면서 콜드 스타트마다
 * 그것을 물게 된다. 공개값만으로 하는 연산을 잎 모듈로 분리해, 검증 경로가
 * 개인키 파생 경로의 의존성을 상속하지 않게 한다.
 *
 * 그래서 이 파일은 프로젝트 내부 파일을 하나도 import 하지 않는다.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** 봉투의 발신자 key id (§10.6) */
export const KEY_ID_BYTES = 8

/** key id 파생 라벨. 시드 파생 라벨(INFO_SIGN / INFO_KEM)과 같은 규칙으로 도메인을 가른다. */
const INFO_KEY_ID = new TextEncoder().encode('agent-channel-mesh/v1/keyid')

/**
 * key id 를 파생한다 — KEM 공개키와 서명 공개키 **둘 다**를 묶는다 (§10.12).
 *
 * 서명된 수신함 폴링에서 릴레이는 `key id == keyIdOf(제시된 공개키)` 와
 * Ed25519 서명 두 가지를 검사한다. key id 를 KEM 공개키에서만 뽑으면 그
 * 검사가 아무것도 보장하지 않는다 — 두 키는 같은 시드에서 서로 다른 HKDF
 * 라벨(INFO_SIGN / INFO_KEM)로 갈라져 한쪽에서 다른 쪽을 계산할 수 없고,
 * KEM 공개키는 채널 멤버 전원이 들고 있다. 공격자가 피해자의 KEM 공개키에
 * 자기가 방금 만든 서명 키쌍을 붙여 제시하면 key id 도 맞고 서명도 자기
 * 키로 검증되므로 남의 큐를 드레인한다. 두 키를 함께 묶으면 제시된 서명키가
 * 큐 주인의 것임이 key id 자체로 증명된다.
 *
 * 두 피연산자 모두 32B 고정이라 이어붙이기에 길이 모호성이 없다 —
 * 다른 (kem, sign) 쌍이 같은 바이트열로 접히지 않는다.
 */
export function keyIdOf(kemPublicKey: Uint8Array, signPublicKey: Uint8Array): Uint8Array {
  const input = new Uint8Array(INFO_KEY_ID.length + kemPublicKey.length + signPublicKey.length)
  input.set(INFO_KEY_ID, 0)
  input.set(kemPublicKey, INFO_KEY_ID.length)
  input.set(signPublicKey, INFO_KEY_ID.length + kemPublicKey.length)
  return sha256(input).slice(0, KEY_ID_BYTES)
}

/** 서명 검증. 예외를 던지지 않고 boolean 을 준다. */
export function verify(
  signPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, signPublicKey)
  } catch {
    return false
  }
}
