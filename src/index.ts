/**
 * agent-channel-mesh — 메시 코어 공개 API
 *
 * 여기 있는 것은 전부 **에이전트 무관**이다. 어댑터가 아니라 코어다 —
 * `claude/channel` 같은 에이전트 고유 호출은 이 경계를 넘지 않는다
 * (CLAUDE.md「코어와 어댑터 경계」).
 *
 * 설계 정본은 docs/architecture.md.
 */

// 신원 — 시드 하나에서 서명키·KEM 키를 파생한다 (§10.2)
export {
  createIdentity,
  deriveIdentity,
  generateSeed,
  sign,
  verify,
  SEED_BYTES,
  KEY_ID_BYTES,
  type Identity,
} from './identity/keys.ts'

// 지문 — 사람이 대조하는 128비트 (§9)
export {
  fingerprint,
  toWords,
  fromWords,
  toHex,
  format,
  FINGERPRINT_BYTES,
} from './identity/fingerprint.ts'

// 봉투 — 전송 형식 (§10.6)
export {
  encode,
  decode,
  headerBytes,
  signingBytes,
  MAGIC,
  CHANNEL_TAG_BYTES,
  MESSAGE_ID_BYTES,
  NONCE_BYTES,
  SIGNATURE_BYTES,
  WRAPPED_KEY_BYTES,
  MAX_BODY_BYTES,
  MAX_RECIPIENTS,
  type Envelope,
  type Header,
  type WrappedKey,
} from './crypto/envelope.ts'

// 봉인·개봉 — HPKE 래핑 + XChaCha20-Poly1305 본문 (§10.2 · §10.3)
export { seal, open, keyIdOf, type SealInput, type OpenInput, type Recipient } from './crypto/seal.ts'

// 재전송 방지 (§10.5)
export {
  ReplayGuard,
  WINDOW_BITS,
  FRESHNESS_MS,
  type Verdict,
  type Reason,
  type GuardOptions,
} from './crypto/replay.ts'

/**
 * 수신 경로 (§10.5).
 *
 * **받는 쪽은 이걸 쓴다.** `open()` 을 직접 부르면 검사 순서를 틀려도
 * 모든 검사가 통과하고, 재전송 폭주가 비대칭 연산을 소모하지 않는다는
 * 성질만 조용히 사라진다.
 */
export { receive, type Received, type ReceiveInput, type RejectReason } from './crypto/receive.ts'

// 채널 — 참여 노드의 집합 (§5 · §8 · §10.11)
export {
  Channel,
  deriveTag,
  CHANNEL_SECRET_BYTES,
  type Member,
  type ResolvedMember,
  type ChannelInit,
} from './channel/channel.ts'

// 발화 제어 — 종료 조건 없는 대화를 만들지 않는다 (§7)
export {
  SpeechControl,
  DEFAULT_MAX_HOPS,
  DEFAULT_MESSAGE_BUDGET,
  type Decision,
  type Incoming,
  type SilenceReason,
  type SpeechOptions,
} from './channel/speech.ts'

// 릴레이 — 서버 쪽 (§10.7)
export { Relay, MAX_ENVELOPE_BYTES, type PostResult, type RelayOptions } from './relay/relay.ts'
export { MemoryStore, DEFAULT_TTL_MS, type Store, type Stored } from './relay/store.ts'
export {
  createHandler,
  fromBase64,
  type HttpOptions,
  type PostBody,
  type FetchBody,
  type ErrorBody,
  type HealthBody,
} from './relay/http.ts'

// 릴레이 — 클라이언트 쪽. 코어가 암호문을 주고받는 통로다.
export {
  RelayClient,
  RelayError,
  DEFAULT_POLL_MS,
  type ClientOptions,
} from './relay/client.ts'

/**
 * 노드 — 코어의 조립체 (§4).
 *
 * **어댑터는 이것만 쓴다.** `seal`/`receive` 를 직접 부르면 검사 순서(§10.5)나
 * 발화 제어(§7)를 빠뜨릴 수 있고, 그러면 에이전트마다 보안 속성이 갈린다.
 */
export {
  MeshNode,
  type Inbound,
  type Dropped,
  type DropReason,
  type JoinOptions,
  type NodeOptions,
} from './node/node.ts'
