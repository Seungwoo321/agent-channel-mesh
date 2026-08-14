/**
 * 봉인·개봉 — HPKE 키 래핑 + XChaCha20-Poly1305 본문
 *
 * 설계 근거는 docs/architecture.md §10.2 · §10.3.
 *
 * 본문은 한 번만 암호화하고 콘텐츠 키를 수신자 수만큼 HPKE 로 감싼다.
 * 그룹 키가 없으므로 회전할 것도 없다 — 멤버 변경은 다음 메시지의
 * 수신자 목록이 달라지는 것뿐이다.
 */
import { CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import type { Identity } from '../identity/keys.ts'
import { sign, verify, KEY_ID_BYTES } from '../identity/keys.ts'
import {
  type Envelope,
  type Header,
  type WrappedKey,
  CHANNEL_TAG_BYTES,
  MESSAGE_ID_BYTES,
  MAX_BODY_BYTES,
  MAX_RECIPIENTS,
  NONCE_BYTES,
  WRAPPED_KEY_BYTES,
  headerBytes,
  signingBytes,
} from './envelope.ts'

/**
 * HPKE Base 모드 — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305
 *
 * Auth 모드를 쓰지 않는다: 발신자를 한 수신자에게만 인증하므로 N명 채널에서
 * 멤버끼리 "같은 발신자를 봤는가"를 확인할 수 없다 (§10.2).
 */
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
})

const CONTENT_KEY_BYTES = 32
const HPKE_INFO = new TextEncoder().encode('agent-channel-mesh/v1/wrap')

/** 수신자 지정 — KEM 공개키와 그 key id */
export interface Recipient {
  readonly kemPublicKey: Uint8Array
}

/** key id 는 KEM 공개키에서 뽑는다. 지문의 축약이 아니다. */
export function keyIdOf(kemPublicKey: Uint8Array): Uint8Array {
  return sha256(kemPublicKey).slice(0, KEY_ID_BYTES)
}

export interface SealInput {
  readonly sender: Identity
  readonly recipients: readonly Recipient[]
  readonly channelTag: Uint8Array
  readonly seq: bigint
  readonly plaintext: Uint8Array
  /** 테스트 결정성을 위해서만 주입한다. 운영에서는 비운다. */
  readonly messageId?: Uint8Array
  readonly timestamp?: bigint
  readonly nonce?: Uint8Array
}

/**
 * 메시지를 봉인한다.
 *
 * nonce 는 매번 랜덤 192비트다 — 카운터를 쓰지 않는다. 브릿지는 재시작되는
 * 서브프로세스라 카운터를 잃으면 nonce 를 재사용하고, 그건 치명적이다 (§10.2).
 */
export async function seal(input: SealInput): Promise<Envelope> {
  const { sender, recipients, channelTag, seq, plaintext } = input

  if (recipients.length === 0) throw new Error('수신자가 없다')
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(`수신자가 너무 많다 (${recipients.length} > ${MAX_RECIPIENTS})`)
  }
  if (plaintext.length > MAX_BODY_BYTES) {
    throw new Error(`본문이 너무 크다 (${plaintext.length}B)`)
  }
  if (channelTag.length !== CHANNEL_TAG_BYTES) {
    throw new Error(`채널 태그는 ${CHANNEL_TAG_BYTES}바이트여야 한다`)
  }

  const header: Header = {
    channelTag,
    messageId: input.messageId ?? randomBytes(MESSAGE_ID_BYTES),
    senderKeyId: sender.keyId,
    seq,
    timestamp: input.timestamp ?? BigInt(Date.now()),
    nonce: input.nonce ?? randomBytes(NONCE_BYTES),
  }

  // 메시지마다 새 콘텐츠 키 — 재시작 상태 문제가 아예 생기지 않는다.
  const contentKey = randomBytes(CONTENT_KEY_BYTES)
  const aad = headerBytes(header)

  // 본문은 한 번만 암호화한다 (§10.3).
  const body = xchacha20poly1305(contentKey, header.nonce, aad).encrypt(plaintext)

  // 콘텐츠 키를 수신자 수만큼 감싼다.
  const keys: WrappedKey[] = []
  for (const r of recipients) {
    const publicKey = await suite.kem.deserializePublicKey(r.kemPublicKey.buffer as ArrayBuffer)
    const ctx = await suite.createSenderContext({ recipientPublicKey: publicKey, info: HPKE_INFO })
    const sealed = new Uint8Array(await ctx.seal(contentKey.buffer as ArrayBuffer, aad.buffer as ArrayBuffer))
    const enc = new Uint8Array(ctx.enc)
    const wrapped = new Uint8Array(WRAPPED_KEY_BYTES)
    wrapped.set(enc, 0)
    wrapped.set(sealed, enc.length)
    keys.push({ keyId: keyIdOf(r.kemPublicKey), wrapped })
  }

  contentKey.fill(0)

  return { header, keys, body, signature: sign(sender, signingBytes(header, keys, body)) }
}

export interface OpenInput {
  readonly envelope: Envelope
  readonly recipient: Identity
  /** 발신자의 Ed25519 공개키. 신뢰 목록에서 조회해 넘긴다. */
  readonly senderSignPublicKey: Uint8Array
}

/**
 * 봉투를 연다.
 *
 * 검사 순서가 중요하다 — 싼 것부터 한다. 서명 검증을 비대칭 언랩보다
 * 먼저 해서, 위조 봉투 폭주가 X25519 연산을 소모하지 않게 한다 (§10.5).
 */
export async function open(input: OpenInput): Promise<Uint8Array> {
  const { envelope, recipient, senderSignPublicKey } = input
  const { header, keys, body, signature } = envelope

  // 1. 발신자 서명 — 대칭 연산, 가장 싸다.
  if (!verify(senderSignPublicKey, signingBytes(header, keys, body), signature)) {
    throw new Error('발신자 서명이 유효하지 않다')
  }

  // 2. 발신자 key id 가 서명한 신원과 맞는가.
  //    서명은 통과하지만 헤더의 key id 가 다른 경우를 잡는다.
  const claimed = header.senderKeyId
  if (claimed.length !== KEY_ID_BYTES) throw new Error('발신자 key id 가 규격에 맞지 않다')

  // 3. 내 몫의 래핑 키를 찾는다.
  const mine = keys.find(k => equal(k.keyId, recipient.keyId))
  if (!mine) throw new Error('이 봉투의 수신자가 아니다')

  // 4. 비대칭 언랩 — 가장 비싸다. 여기까지 왔다는 건 서명이 통과했다는 뜻.
  const aad = headerBytes(header)
  const enc = mine.wrapped.subarray(0, 32)
  const sealedKey = mine.wrapped.subarray(32)
  const ctx = await suite.createRecipientContext({
    recipientKey: recipient.kemPrivateKey,
    enc: enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer,
    info: HPKE_INFO,
  })
  const contentKey = new Uint8Array(
    await ctx.open(
      sealedKey.buffer.slice(
        sealedKey.byteOffset,
        sealedKey.byteOffset + sealedKey.byteLength,
      ) as ArrayBuffer,
      aad.buffer as ArrayBuffer,
    ),
  )

  // 5. 본문 복호 — AAD 결속이 여기서 검증된다. 헤더가 고쳐졌으면 실패한다.
  try {
    return xchacha20poly1305(contentKey, header.nonce, aad).decrypt(body)
  } finally {
    contentKey.fill(0)
  }
}

/** 상수 시간 비교. key id 조회에도 타이밍 누출을 두지 않는다. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
