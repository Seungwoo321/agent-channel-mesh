/**
 * 노드 — 메시 코어의 조립체
 *
 * 설계 근거는 docs/architecture.md §4「메시 코어」.
 *
 * 신원·채널·암복호·재전송 방지·발화 제어·릴레이 통신을 한 객체로 묶는다.
 * **어댑터는 이 객체만 본다** — 어댑터가 `seal()`/`receive()` 를 직접 부르면
 * 검사 순서(§10.5)나 발화 제어(§7)를 빠뜨릴 수 있고, 그러면 에이전트마다
 * 보안 속성이 달라진다. 그것을 막는 것이 이 파일의 존재 이유다.
 *
 * 여기에 에이전트 고유 코드는 하나도 없다. `claude/channel` 은 이 경계를
 * 넘지 않는다 (CLAUDE.md「코어와 어댑터 경계」).
 */
import type { Identity } from '../identity/keys.js'
import { seal } from '../crypto/seal.js'
import { encode, peekChannelTag } from '../crypto/envelope.js'
import { receive, type RejectReason } from '../crypto/receive.js'
import { ReplayGuard } from '../crypto/replay.js'
import { Channel } from '../channel/channel.js'
import { SpeechControl, type Decision, type SpeechOptions } from '../channel/speech.js'
import { RelayClient } from '../relay/client.js'

/** 채널에 붙일 때 주는 정책. 채널마다 다를 수 있다. */
export interface JoinOptions {
  /** 내가 응답할 이름들. 비우면 모든 메시지에 응답한다 (§7). */
  readonly mentions?: readonly string[]
  readonly maxHops?: number
  readonly messageBudget?: number
}

/** 어댑터에 전달되는, 복호화가 끝난 메시지. */
export interface Inbound {
  readonly channelId: string
  /** 발신자 KEM key id. */
  readonly senderKeyId: Uint8Array
  /** 발신자의 사람용 이름. 멤버 목록에 있으면 채워진다 — 신뢰의 근거는 아니다. */
  readonly senderLabel?: string
  readonly text: string
  readonly messageId: Uint8Array
  /** 발신자가 실은 시각(ms). 발신자가 정하는 값이라 신뢰 대상이 아니다. */
  readonly sentAt: bigint
  /** 이 사슬의 홉 수. 응답할 때 +1 해서 실어 보낸다. */
  readonly hops: number
  /**
   * 발화 판정 (§7).
   *
   * 메시지는 **판정과 무관하게** 전달된다 — "읽되 응답하지 않는다"가
   * 멘션 규칙의 정의라서다. 응답 여부는 어댑터가 이 값을 보고 정한다.
   */
  readonly decision: Decision
}

/**
 * 버려진 메시지. 진단용으로만 노출한다.
 *
 * `receive()` 의 거부 사유에 `unknown-channel` 을 더한다 — 붙어 있지 않은
 * 채널의 봉투는 복호화까지 가기 전에 여기서 끝나므로, 그 사유는
 * 수신 경로가 아니라 노드 층에 속한다.
 */
export type DropReason = RejectReason | 'unknown-channel'

export interface Dropped {
  readonly reason: DropReason
  readonly detail: string
}

export interface NodeOptions {
  readonly identity: Identity
  /** 릴레이 URL. 없으면 릴레이 없이 동작한다 — 테스트·로컬 전용. */
  readonly relay?: RelayClient
  /** 지금 시각. 테스트에서만 주입한다. */
  readonly now?: () => number
}

/** 채널 하나에 대한 로컬 상태 묶음. */
interface Joined {
  readonly channel: Channel
  readonly speech: SpeechControl
  readonly guard: ReplayGuard
  /** 이 채널에서 내가 보낸 마지막 seq. 봉투마다 1씩 올린다 (§10.5). */
  seq: bigint
}

/**
 * 메시 노드.
 *
 * 개인키를 갖는 유일한 곳이다. 릴레이도 모델도 이 객체 밖의 무엇도
 * 개인키를 보지 않는다.
 */
export class MeshNode {
  readonly identity: Identity
  private readonly relay?: RelayClient
  private readonly now: () => number
  private readonly channels = new Map<string, Joined>()

  constructor(options: NodeOptions) {
    this.identity = options.identity
    this.relay = options.relay
    this.now = options.now ?? Date.now
  }

  /**
   * 채널에 붙는다.
   *
   * 채널 id 는 태그 hex 다 — 같은 비밀을 아는 노드들이 같은 id 를 얻는다.
   * 사람이 정한 이름을 쓰지 않는 이유는 그것이 노드마다 다를 수 있어서다.
   */
  join(channel: Channel, options: JoinOptions = {}): string {
    const id = hex(channel.tag)
    if (this.channels.has(id)) return id

    const speechOptions: SpeechOptions = {
      selfKeyId: this.identity.keyId,
      mentions: options.mentions,
      maxHops: options.maxHops,
      messageBudget: options.messageBudget,
    }
    this.channels.set(id, {
      channel,
      speech: new SpeechControl(speechOptions),
      guard: new ReplayGuard(),
      seq: 0n,
    })
    return id
  }

  leave(channelId: string): boolean {
    return this.channels.delete(channelId)
  }

  channel(channelId: string): Channel | undefined {
    return this.channels.get(channelId)?.channel
  }

  /** 붙어 있는 채널 id 들. 어댑터가 사람에게 보여줄 목록이다. */
  channelIds(): string[] {
    return [...this.channels.keys()]
  }

  speech(channelId: string): SpeechControl | undefined {
    return this.channels.get(channelId)?.speech
  }

  /**
   * 채널에 평문을 보낸다.
   *
   * 어댑터의 `send` 툴이 결국 여기로 온다. 평문이 코어 밖으로 나가는 일이
   * 없도록, 봉인은 반드시 이 안에서 일어난다.
   *
   * `hops` 는 응답일 때 받은 메시지의 `hops` 를 그대로 넘긴다 — 사슬 길이를
   * 이어 세는 값이며, 새 대화를 시작할 때는 생략한다.
   */
  async send(channelId: string, text: string, hops = 0): Promise<Uint8Array> {
    const joined = this.channels.get(channelId)
    if (!joined) throw new Error(`붙어 있지 않은 채널이다: ${channelId}`)

    const recipients = joined.channel.recipients(this.identity.keyId)
    if (recipients.length === 0) {
      throw new Error('수신자가 없다 — 나 말고 아무도 없는 채널이다')
    }

    joined.seq += 1n
    const envelope = await seal({
      sender: this.identity,
      recipients,
      channelTag: joined.channel.tag,
      seq: joined.seq,
      plaintext: new TextEncoder().encode(withHops(text, hops)),
      // 노드의 시계를 쓴다. `seal` 기본값과 같은 `Date.now()` 지만, 주입된
      // 시계로 신선도 창(§10.5)을 테스트하려면 여기서 넘겨야 한다.
      timestamp: BigInt(this.now()),
    })

    const wire = encode(envelope)
    if (this.relay) await this.relay.post(wire)
    // 실제로 나갔을 때만 예산을 깎는다 (§7 — 판정과 기록의 분리).
    joined.speech.spend()
    return wire
  }

  /**
   * 도착한 봉투를 처리한다.
   *
   * 검사 순서는 `receive()` 가 고정한다 — 여기서 다시 조립하지 않는다.
   * 채널을 찾는 것은 봉투의 평문 채널 태그로 하고(§10.6), 그것이 릴레이가
   * 못 읽는 값에 의존하지 않는 유일한 라우팅 근거다.
   */
  async accept(wire: Uint8Array): Promise<Inbound | Dropped> {
    // 태그를 먼저 본다 — 모르는 채널이면 복호화까지 갈 이유가 없다.
    const tagBytes = peekChannelTag(wire)
    if (!tagBytes) return { reason: 'malformed', detail: '봉투 형식이 아니다' }
    const tag = hex(tagBytes)

    const joined = this.channels.get(tag)
    if (!joined) return { reason: 'unknown-channel', detail: `모르는 채널이다: ${tag}` }

    const got = await receive({
      wire,
      recipient: this.identity,
      guard: joined.guard,
      lookupSender: joined.channel.lookupSender,
    })
    if (!got.ok) return { reason: got.reason, detail: got.detail }

    const raw = new TextDecoder().decode(got.plaintext)
    const { text, hops } = splitHops(raw)
    const sender = joined.channel.get(got.envelope.header.senderKeyId)

    return {
      channelId: tag,
      senderKeyId: got.envelope.header.senderKeyId,
      senderLabel: sender?.label,
      text,
      messageId: got.envelope.header.messageId,
      sentAt: got.envelope.header.timestamp,
      hops,
      decision: joined.speech.check({
        senderKeyId: got.envelope.header.senderKeyId,
        text,
        hops,
      }),
    }
  }

  /**
   * 릴레이를 폴링하며 도착한 메시지를 넘긴다.
   *
   * 어댑터는 이 루프만 돌면 된다 — 복호화도 정책 판정도 이미 끝나 있다.
   * 버려진 봉투는 `onDropped` 로만 알린다. 던지지 않는 이유는 나쁜 봉투
   * 하나가 루프를 죽이면 그것이 곧 서비스 거부라서다.
   */
  async *listen(onDropped?: (d: Dropped) => void): AsyncGenerator<Inbound, void, void> {
    if (!this.relay) throw new Error('릴레이가 없다 — listen 하려면 relay 를 주입해야 한다')
    for await (const wire of this.relay.poll()) {
      const result = await this.accept(wire)
      if ('reason' in result) onDropped?.(result)
      else yield result
    }
  }

  /** 폴링을 멈춘다. */
  stop(): void {
    this.relay?.stop()
  }
}

/**
 * 홉 수를 본문에 실어 보낸다.
 *
 * 헤더가 아니라 본문에 두는 이유: 헤더는 평문이라(§10.6) 릴레이가 홉을
 * 보게 된다. 홉은 대화 구조에 대한 정보라 굳이 흘릴 이유가 없고, 본문에
 * 두면 AEAD 로 보호되면서 발신자만 정할 수 있다.
 *
 * 발신자가 위조할 수 있다는 점은 변하지 않는다 — 그건 예산이 받친다 (§7).
 */
const HOPS_PREFIX = 'acm/h:'

function withHops(text: string, hops: number): string {
  return `${HOPS_PREFIX}${hops}\n${text}`
}

function splitHops(raw: string): { text: string; hops: number } {
  if (!raw.startsWith(HOPS_PREFIX)) return { text: raw, hops: 0 }
  const nl = raw.indexOf('\n')
  if (nl < 0) return { text: raw, hops: 0 }
  const hops = Number(raw.slice(HOPS_PREFIX.length, nl))
  if (!Number.isInteger(hops) || hops < 0) return { text: raw.slice(nl + 1), hops: 0 }
  return { text: raw.slice(nl + 1), hops }
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
