/**
 * 신원 — Ed25519(서명) + X25519(KEM), 32바이트 시드 하나에서 파생
 *
 * 설계 근거는 docs/architecture.md §10.2.
 *
 * Bun 의 crypto.subtle 로 X25519 를 하지 않는다 — deriveBits 가
 * NotSupportedError 로 죽는다. 반드시 @hpke/dhkem-x25519 를 거친다.
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { fingerprint, format, toWords } from './fingerprint.ts'

const kem = new DhkemX25519HkdfSha256()

export const SEED_BYTES = 32
/** 봉투의 발신자 key id (§10.6) */
export const KEY_ID_BYTES = 8

/** 시드에서 두 키를 파생할 때의 도메인 분리 라벨. 절대 재사용하지 않는다. */
const INFO_SIGN = new TextEncoder().encode('agent-channel-mesh/v1/identity/ed25519')
const INFO_KEM = new TextEncoder().encode('agent-channel-mesh/v1/identity/x25519')

export interface Identity {
  /** 32B 시드. 이것만 저장하면 나머지는 전부 재파생된다. */
  readonly seed: Uint8Array
  readonly signPublicKey: Uint8Array
  readonly signPrivateKey: Uint8Array
  readonly kemPublicKey: Uint8Array
  readonly kemPrivateKey: CryptoKey
  /** 지문 16B — 서명 공개키 기준 (§9) */
  readonly fingerprint: Uint8Array
  /** 봉투 라우팅용 8B. 지문의 축약이 아니라 KEM 공개키에서 따로 뽑는다. */
  readonly keyId: Uint8Array
}

/** 새 신원의 시드를 만든다. */
export function generateSeed(): Uint8Array {
  return randomBytes(SEED_BYTES)
}

/**
 * 시드에서 신원을 파생한다. 같은 시드는 항상 같은 신원을 준다.
 *
 * 두 키를 시드에서 직접 쓰지 않고 HKDF 로 분리한다 — 한쪽 키의
 * 유출이 다른 쪽을 노출시키지 않도록 도메인을 가른다.
 */
export async function deriveIdentity(seed: Uint8Array): Promise<Identity> {
  if (seed.length !== SEED_BYTES) {
    throw new Error(`시드는 ${SEED_BYTES}바이트여야 한다 (받은 값: ${seed.length})`)
  }

  const signPrivateKey = hkdf(sha256, seed, undefined, INFO_SIGN, 32)
  const signPublicKey = ed25519.getPublicKey(signPrivateKey)

  const kemSeed = hkdf(sha256, seed, undefined, INFO_KEM, 32)
  const kp = await kem.deriveKeyPair(kemSeed.buffer as ArrayBuffer)
  // serializePublicKey 는 ArrayBuffer 를 준다 — noble 은 Uint8Array 만 받는다.
  const kemPublicKey = new Uint8Array(await kem.serializePublicKey(kp.publicKey))

  return {
    seed,
    signPrivateKey,
    signPublicKey,
    kemPublicKey,
    kemPrivateKey: kp.privateKey,
    fingerprint: fingerprint(signPublicKey),
    keyId: sha256(kemPublicKey).slice(0, KEY_ID_BYTES),
  }
}

/** 새 신원을 만든다. */
export async function createIdentity(): Promise<Identity> {
  return deriveIdentity(generateSeed())
}

/** 봉투 서명 (§10.2 — HPKE Auth 모드가 아닌 분리 서명) */
export function sign(id: Identity, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, id.signPrivateKey)
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

/** 사람이 대조할 지문 표현 (§9) */
export function fingerprintText(id: Identity): string {
  return format(id.fingerprint)
}

/** 지문 16단어 */
export function fingerprintWords(id: Identity): string[] {
  return toWords(id.fingerprint)
}
