/**
 * 로컬 저장소 — 복호화한 대화가 남는 유일한 곳
 *
 * 설계 근거는 docs/architecture.md §6.3「로컬 저장소는 코어가 소유한다」·
 * §6.4「대화는 세 축으로 갈린다」· §6.6「도착을 세션이 알게 하는 세 경로」.
 *
 * 릴레이는 7일 뒤 지우고 애초에 읽지도 못한다(§10.7). 대화가 남으려면
 * 복호화한 쪽이 남겨야 하고, 그 일은 **코어의 것**이다 — "받은 것을 기록한다"에
 * 에이전트 고유한 것이 없기 때문이다. 어댑터마다 두면 두 벌로 갈리고,
 * 그러면 어느 쪽도 전체를 보지 못한다.
 *
 * 여기 쌓이는 것은 **평문**이다. 위협 모델이 릴레이와 정반대다 — 설정 파일을
 * 0600 으로 막아 놓고(§11) 대화 전문을 그 옆에 평문으로 쌓으면 그 방어가
 * 의미를 잃는다. 그래서 권한 검사·보관 기한·실삭제는 편의 기능이 아니라
 * 요구사항이다.
 *
 * **채널당 파일 하나**로 둔다. 한 파일에 전 채널을 몰면 purge 가 "걸러서 다시
 * 쓰기"가 되어, 지운 대화의 바이트가 파일 안에 잔존한다. §6.3 의 "삭제는 실제
 * 삭제다"가 성립하는 형상은 채널당 파일뿐이고, 그때 purge 는 `unlink()` 다.
 *
 * **소비자는 한 프로세스가 아니다.** 어댑터(MCP 서버)와 훅은 별개 프로세스이고
 * 둘 다 이 파일을 읽고 고쳐 쓴다. 그래서 두 겹의 보호가 있다.
 *
 * - **변경 경로는 전부 채널 잠금 안에서 돈다**(src/store/lock.ts). `write()` 의
 *   temp+rename 은 *한 번의 쓰기*만 원자적이라, 읽고-고치고-쓰는 구간은 그것만으로
 *   보호되지 않는다. 잠금이 없으면 나중 쓰기가 앞선 쓰기를 통째로 덮어 **도착한
 *   메시지가 사라진다**. 순수 읽기는 잠금을 잡지 않는다.
 * - **전달은 리스로 선점한다**(`claimUndelivered`). "읽어서 내보내고 나중에
 *   전달됨으로 찍는다"는 두 단계 사이가 창이라, 그 사이에 다른 프로세스가 같은
 *   것을 집으면 **같은 말이 두 번 간다**. 읽기와 표시를 한 번의 잠금 안에서 함께
 *   한다 — §6.6 의 "중복은 상태로 막는다"가 프로세스 사이에서도 성립해야 한다.
 */
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from './lock.js'
import { isGrant, type Authority, type Grant } from '../policy/authority.js'

/** 메시지가 흐른 방향. 내가 보낸 것과 받은 것을 섞지 않는다. */
export type Direction = 'in' | 'out'

/**
 * 대화 축 (§6.4).
 *
 * 한 흐름으로 섞으면 사고가 난다 — 내 지시가 채널로 새거나, 채널에서 온 말이
 * 내 지시처럼 보여 §7 발화 제어를 우회한다. **분리는 UI 이전에 저장 시점의
 * 일이다.** 저장할 때 갈려 있어야 UI 가 무엇을 보든 섞이지 않는다.
 */
export type Axis = 'external' | 'internal' | 'local'

/** 기본 저장 위치. 설정 파일 옆이다 — 같은 위협 모델, 같은 권한 기준. */
export const DEFAULT_STORE_DIR = '~/.agent-channel-mesh/messages'

/**
 * 기본 보관 기한 30일.
 *
 * §6.3 이 "기본값을 무제한으로 두지 않는다"를 명시한다. 평문 대화가 디스크에
 * 영원히 쌓이는 것이 기본값이면, 유출 한 번의 피해가 시간에 비례해 커진다.
 */
export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** 채널당 보관 개수 상한. 기한과 별개로 파일 크기를 묶어 둔다. */
export const DEFAULT_MAX_PER_CHANNEL = 2000

/**
 * 전달 리스의 유효 시간. 이만큼 지난 선점은 풀린 것으로 본다.
 *
 * 선점은 "내가 지금 이걸 세션에 넣는 중"이라는 표시다. 그 프로세스가 주입
 * 도중에 죽으면 표시만 남고 아무도 그 메시지를 다시 집지 않는다 — §6.6 이
 * 훅을 둔 이유가 "주입이 실패했을 때 뜨는 안전망"인데, 선점이 영구히 남으면
 * 그 안전망이 자기 손으로 막힌다. 그래서 리스에는 반드시 기한이 있다.
 *
 * 60초는 주입 한 번(수백 ms)보다 두 자릿수 넉넉하되, 사람이 기다릴 수 있는
 * 범위다. 짧으면 살아 있는 주입과 겹쳐 중복이 나고, 길면 유실이 오래 안 보인다.
 */
export const DEFAULT_CLAIM_TTL_MS = 60_000

/** 저장 파일의 최대 허용 권한. 설정 파일(§11)과 같은 기준이다. */
const MAX_FILE_MODE = 0o600

/** 저장 디렉토리의 최대 허용 권한. 목록만 읽혀도 채널 id 가 새므로 함께 막는다. */
const MAX_DIR_MODE = 0o700

/** 릴레이 수신 lease 가 heartbeat 없이 살아 있을 수 있는 최대 시간(ms). */
export const DEFAULT_RECEIVER_LEASE_STALE_MS = 30_000

/** 릴레이 수신 lease heartbeat 주기(ms). stale 기준보다 충분히 짧아야 한다. */
export const DEFAULT_RECEIVER_LEASE_HEARTBEAT_MS = 5_000

/** 채널 파일 목록에 잡히지 않는 저장소 전체 수신 lease 파일 이름. */
const RECEIVER_LEASE_FILE = '.receiver.lease'

/**
 * 파일 형식 버전. 형식을 바꿀 때 조용히 오해석하지 않으려고 둔다.
 *
 * 2 = `claimedAt`(전달 리스)이 붙은 형식.
 */
const FORMAT_VERSION = 2

/**
 * 읽어 줄 형식들. **버전 1 을 거부하지 않는다.**
 *
 * 1 과 2 의 차이는 `claimedAt` 이 있느냐뿐이고, 없으면 "선점되지 않음"으로
 * 읽으면 그만이다. 여기서 거부하면 업그레이드 한 번에 기존 사용자의 대화가
 * 통째로 죽는다 — 형식 버전은 오해석을 막으려고 둔 것이지 데이터를 버리라고
 * 둔 것이 아니다. 다음 쓰기에서 2 로 올라간다.
 */
const READABLE_VERSIONS: ReadonlySet<number> = new Set([1, 2])

/** 채널 id 는 채널 태그 hex 다(§10.11). 경로 조각이 되므로 형태를 강제한다. */
const CHANNEL_ID = /^[0-9a-f]{2,64}$/

/** 저장 파일 이름. 임시 파일(`.tmp` 꼬리)이 채널로 잡히지 않게 정확히 맞춘다. */
const CHANNEL_FILE = /^([0-9a-f]{2,64})\.json$/

/** hex 만 저장한다 — `Uint8Array` 가 JSON 을 타면 `{"0":1,…}` 로 뭉개진다. */
const HEX = /^[0-9a-f]+$/

/** 디스크에 남는 한 건. 이 모양이 조망 UI·`inbox` 툴·훅의 공통 입력이다. */
export interface StoredMessage {
  /** hex. 수신은 봉투의 messageId, 발신은 새로 뽑는다. */
  readonly id: string
  readonly channelId: string
  readonly direction: Direction
  readonly axis: Axis
  /** hex. 수신에만 있다 — 발신자는 나이므로 기록할 것이 없다. */
  readonly senderKeyId?: string
  /** 사람이 부르는 이름. 신뢰의 근거가 아니다 (§9). */
  readonly senderLabel?: string
  readonly text: string
  /** 발신자가 실은 시각(ms). 발신자가 정하는 값이라 신뢰 대상이 아니다. */
  readonly sentAt: number
  /** 내가 디스크에 남긴 시각(ms). 보관 기한은 이 값으로 센다. */
  readonly storedAt: number
  readonly hops?: number
  /**
   * 이 말이 나냐 동료냐 (§8).
   *
   * 판정 근거는 축(`axis`)이 아니라 **검증된 서명자**다 — 축은 내가 손으로
   * 적은 채널 분류값이고, 서명자는 Ed25519 검증을 통과한 값이다. 같은
   * 채널에 내 다른 에이전트와 동료가 함께 있을 수 있으므로 판정은 메시지
   * 단위여야 한다.
   *
   * 수신에만 있다. 버전 1·2 파일에는 없고, 없으면 `peer` 로 읽는다 —
   * 모르는 것을 나로 보는 쪽이 위험하다.
   */
  readonly authority?: Authority
  /**
   * 이 말이 내 기계에서 갖는 권한 (§8.2). 도착 시점의 정책으로 정해진다.
   *
   * 도착 시점에 박는 이유는 `mute` 와 같다 — 나중에 정책이 바뀌어도 그때
   * 무엇을 허용한 채로 주입했는지는 바뀌지 않아야 한다.
   */
  readonly grant?: Grant
  /** 답하는 대상의 messageId (§6.2). 스레드가 아니라 본문 안의 참조다. */
  readonly replyTo?: string
  /**
   * 발화 판정이 '응답 안 함' 이었을 때의 사유 (§7). 없으면 응답 대상이다.
   *
   * 판정은 **도착 시점에만** 구할 수 있다 — `SpeechControl` 은 예산·홉 같은
   * 상태를 소비하므로, 읽을 때 다시 물으면 같은 답이 나오지 않는다. 그래서
   * 남기는 자리는 저장 시점뿐이다. 이게 비면 정본을 읽는 `inbox` 툴이 남의
   * 대화를 응답 대상처럼 내주고, 그건 §7 우회다.
   */
  readonly mute?: string
  /**
   * 세션에 전달됐는지 (§6.6).
   *
   * 중복 전달을 막는 것은 프롬프트 지시문이 아니라 **이 상태**다. 지시문은
   * 컨텍스트가 압축되면 사라지고, 모델이 무시해도 막을 방법이 없다.
   */
  readonly delivered: boolean
  /**
   * 전달 리스를 잡은 시각(ms). 없으면 아무도 집지 않은 상태다.
   *
   * `undelivered()` 로 읽고 나중에 `markDelivered()` 로 찍는 두 단계 사이에는
   * 다른 프로세스가 같은 것을 집을 수 있다 — 어댑터와 훅은 별개 프로세스라
   * 그 창이 실재한다. 이 필드는 **읽는 순간 원자적으로 찍혀** 그 창을 없앤다
   * (`claimUndelivered`). 여기까지 해야 §6.6 의 "중복은 지시문이 아니라 상태로
   * 막는다"가 한 프로세스 안에서만 참인 말이 아니게 된다.
   *
   * {@link DEFAULT_CLAIM_TTL_MS} 를 넘긴 선점은 풀린 것으로 본다 — 선점하고
   * 죽은 프로세스의 메시지가 영영 안 나오면 안 된다.
   */
  readonly claimedAt?: number
}

/**
 * 저장을 요청할 때 주는 것. `storedAt`·`delivered`·`claimedAt` 은 저장소가 정한다.
 *
 * 특히 `claimedAt` 은 **저장소만 찍는다.** 호출부가 선점 상태를 들고 들어오면
 * 리스가 "잠금 안에서 원자적으로 정해진다"는 전제가 깨지고, 그 순간 이 필드는
 * 중복 전달을 막지 못한다.
 */
export interface NewMessage
  extends Omit<StoredMessage, 'id' | 'storedAt' | 'delivered' | 'claimedAt'> {
  /** 없으면 새로 뽑는다. 수신은 봉투의 messageId 를 그대로 넣는다. */
  readonly id?: string
}

export interface StoreOptions {
  readonly dir?: string
  readonly retentionMs?: number
  readonly maxPerChannel?: number
  /** 전달 리스 유효 시간(ms). 기본 {@link DEFAULT_CLAIM_TTL_MS}. */
  readonly claimTtlMs?: number
  /** 지금 시각. 테스트에서만 주입한다. */
  readonly now?: () => number
  /**
   * 잠금 획득 총 대기 상한(ms). 테스트에서만 준다 — 기본값(5초)은 ms 단위
   * 임계 구역보다 세 자릿수 넉넉하다.
   */
  readonly lockTimeoutMs?: number
  /** 잠금 stale 판정 기준(ms). 테스트에서만 준다. */
  readonly lockStaleMs?: number
}

/** 수신 lease 파일에 남기는 소유자 정보. */
export interface ReceiverLeaseHolder {
  readonly pid: number
  readonly token: string
  readonly acquiredAt: number
  readonly heartbeatAt: number
}

/** lease 충돌을 외부에 보고할 때 공개할 소유자 메타데이터. capability token은 제외한다. */
export interface ReceiverLeaseConflictHolder {
  readonly pid: number
  readonly acquiredAt: number
  readonly heartbeatAt: number
}

/** 릴레이 수신 lease 획득 정책. 훅은 이 API를 호출하지 않고 로컬 store 만 읽는다. */
export interface ReceiverLeaseOptions {
  /** 이 시간 동안 heartbeat 가 없으면 죽은 receiver 로 보고 회수한다. */
  readonly staleMs?: number
  /** lease 파일 heartbeat 주기. staleMs 보다 짧아야 한다. */
  readonly heartbeatMs?: number
  /** stale lease 회수나 heartbeat 상실을 알린다. 기본값은 stderr 이다. */
  readonly warn?: (message: string) => void
  /** heartbeat 가 갱신되지 않아 lease 를 잃었을 때 호출한다. */
  readonly onLost?: (error: Error) => void
}

/** 같은 identity 저장소의 다른 adapter 가 receiver lease 를 이미 가진 경우다. */
export class ReceiverLeaseError extends Error {
  readonly code = 'RECEIVER_LEASE_HELD'
  readonly path: string
  readonly holder: ReceiverLeaseConflictHolder | undefined

  constructor(path: string, holder: ReceiverLeaseHolder | undefined) {
    const detail =
      holder === undefined
        ? '소유자 정보를 읽을 수 없다'
        : `pid=${holder.pid}, acquired=${holder.acquiredAt}, heartbeat=${holder.heartbeatAt}`
    super(
      `릴레이 수신 lease 를 잡을 수 없다: ${path}. ` +
        `같은 identity 저장소를 사용하는 다른 adapter 가 이미 수신 중이다 (${detail}).`,
    )
    this.name = 'ReceiverLeaseError'
    this.path = path
    this.holder =
      holder === undefined
        ? undefined
        : {
            pid: holder.pid,
            acquiredAt: holder.acquiredAt,
            heartbeatAt: holder.heartbeatAt,
          }
  }
}

/** MessageStore 가 잡은 수신 lease. release 는 소유 token 을 확인하고 멱등적으로 동작한다. */
export interface ReceiverLease {
  readonly path: string
  readonly pid: number
  readonly token: string
  /** 실제로 내 lease 파일을 지웠으면 true, 이미 놓였거나 회수됐으면 false. */
  release(): Promise<boolean>
}

interface ActiveReceiverLease {
  readonly holder: ReceiverLeaseHolder
  readonly warn: (message: string) => void
  readonly onLost: ((error: Error) => void) | undefined
  lease: ReceiverLease
  timer?: ReturnType<typeof setInterval>
  released: boolean
  lost: boolean
}

/** 파일에 실제로 들어가는 형태. */
interface ChannelFile {
  readonly version: number
  readonly channelId: string
  readonly messages: readonly StoredMessage[]
}

/**
 * 로컬 저장소.
 *
 * 세 곳의 합류점이다 — 릴레이 드레인의 착지점, `inbox` 툴의 읽기 대상,
 * 조망 UI 의 유일한 입력(§6.3). 릴레이를 직접 치는 경로를 여러 개 두면
 * 큐가 서로의 메시지를 훔치므로, 정본은 항상 여기다.
 */
export class MessageStore {
  private readonly dir: string
  private readonly retention: number
  private readonly maxPerChannel: number
  private readonly claimTtl: number
  private readonly now: () => number
  private readonly lockTimeoutMs: number | undefined
  private readonly lockStaleMs: number | undefined
  private receiverLease: ActiveReceiverLease | undefined
  private receiverLeaseAcquire: Promise<ReceiverLease> | undefined

  constructor(options: StoreOptions = {}) {
    this.dir = expandHome(options.dir ?? DEFAULT_STORE_DIR)
    this.retention = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.maxPerChannel = options.maxPerChannel ?? DEFAULT_MAX_PER_CHANNEL
    this.claimTtl = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
    this.now = options.now ?? Date.now
    this.lockTimeoutMs = options.lockTimeoutMs
    this.lockStaleMs = options.lockStaleMs
    // 리스에 기한이 없으면 선점하고 죽은 프로세스의 메시지가 영영 안 나온다.
    if (!Number.isFinite(this.claimTtl) || this.claimTtl <= 0) {
      throw new Error('claimTtlMs 는 유한한 양수여야 한다 — 기한 없는 선점은 유실이다')
    }
    // 무제한 보관은 옵션으로도 열어 두지 않는다 — 기본값만 유한하면 호출부가
    // Infinity 를 넣어 §6.3 을 우회한다.
    if (!Number.isFinite(this.retention) || this.retention <= 0) {
      throw new Error('보관 기한은 유한한 양수여야 한다 — 무제한 보관은 허용하지 않는다 (§6.3)')
    }
    if (!Number.isInteger(this.maxPerChannel) || this.maxPerChannel <= 0) {
      throw new Error('maxPerChannel 은 1 이상의 정수여야 한다')
    }
  }

  /** 보관 기한(ms). 무제한이 아니라는 것을 밖에서 확인할 수 있어야 한다. */
  get retentionMs(): number {
    return this.retention
  }

  /** 전달 리스 유효 시간(ms). 기한이 있다는 것을 밖에서 확인할 수 있어야 한다. */
  get claimTtlMs(): number {
    return this.claimTtl
  }

  /**
   * 저장 디렉토리(`~` 가 펴진 절대경로).
   *
   * 권한 오염 상태(§8.3)가 이 자리에 같이 놓인다. 소비자가 경로를 다시
   * 계산하지 않게 하려고 연다 — 설정에서 두 번 유도하면 어댑터와 훅이 서로
   * 다른 파일을 보게 되고, 그러면 한쪽이 찍은 오염을 다른 쪽이 못 본다.
   */
  get directory(): string {
    return this.dir
  }

  /** 이 저장소의 릴레이 receiver lease 파일이 있는 자리. */
  get receiverLeasePath(): string {
    return receiverLeasePathOf(this.dir)
  }

  /** 이 인스턴스가 아직 릴레이 수신권을 보유하고 있는지. */
  get receiverLeaseActive(): boolean {
    const active = this.receiverLease
    return active !== undefined && !active.released && !active.lost
  }

  /**
   * 저장소 전체의 릴레이 drain 권한을 독점한다.
   *
   * 채널별 `.json.lock` 은 read-modify-write 를 직렬화할 뿐, 두 adapter 중 누가
   * 릴레이를 읽을지는 정하지 않는다. 이 lease 는 그보다 한 단계 바깥의
   * 저장소 전체 경계다. 훅은 이 메서드를 호출하지 않으므로, 이미 저장된
   * 메시지를 읽는 fallback 경로와 receiver 독점권이 서로 막지 않는다.
   *
   * 반환된 lease 를 서버의 `try/finally` 에서 release 해야 한다. heartbeat 가
   * 끊기면 lease 를 잃은 것으로 표시하고 `onLost` 를 호출하므로, 서버는 poll
   * 루프도 중단해야 한다.
   */
  async acquireReceiverLease(options: ReceiverLeaseOptions = {}): Promise<ReceiverLease> {
    const current = this.receiverLease
    if (current !== undefined) {
      if (!current.released && !current.lost && current.lease !== undefined) return current.lease
      this.receiverLease = undefined
    }
    if (this.receiverLeaseAcquire !== undefined) return this.receiverLeaseAcquire

    const pending = this.acquireReceiverLeaseOnce(options)
    this.receiverLeaseAcquire = pending
    try {
      return await pending
    } finally {
      if (this.receiverLeaseAcquire === pending) this.receiverLeaseAcquire = undefined
    }
  }

  /** 이 MessageStore 인스턴스가 가진 receiver lease 를 token 검증 후 정상 해제한다. */
  async releaseReceiverLease(): Promise<boolean> {
    const active = this.receiverLease
    if (active === undefined) return false
    return this.releaseReceiverLeaseFor(active)
  }

  private async acquireReceiverLeaseOnce(options: ReceiverLeaseOptions): Promise<ReceiverLease> {
    const staleMs = requireReceiverLeaseDuration(
      options.staleMs ?? DEFAULT_RECEIVER_LEASE_STALE_MS,
      'receiver lease staleMs',
    )
    const heartbeatMs = requireReceiverLeaseDuration(
      options.heartbeatMs ?? DEFAULT_RECEIVER_LEASE_HEARTBEAT_MS,
      'receiver lease heartbeatMs',
    )
    if (heartbeatMs >= staleMs) {
      throw new Error('receiver lease heartbeatMs 는 staleMs 보다 짧아야 한다')
    }

    const path = this.receiverLeasePath
    const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`))
    await this.ensureDir()

    const holder = await withLock(
      path,
      async () => {
        const existing = await readReceiverLease(path)
        const age = await receiverLeaseAge(path, existing, this.now)
        if (age !== undefined) {
          if (age < staleMs) throw new ReceiverLeaseError(path, existing)
          warn(
            `[agent-channel-mesh] 오래된 receiver lease 를 회수한다: ${path} ` +
              `(${Math.round(age)}ms 경과, 기준 ${staleMs}ms). ` +
              `수신 중이던 프로세스가 죽은 것으로 본다.`,
          )
          await unlinkExisting(path)
        }

        const next: ReceiverLeaseHolder = {
          pid: process.pid,
          token: randomHex(16),
          acquiredAt: this.now(),
          heartbeatAt: this.now(),
        }
        await createReceiverLease(path, next)
        return next
      },
      { ...this.lockOptions(), ensureDir: () => this.ensureDir() },
    )

    const active: ActiveReceiverLease = {
      holder,
      warn,
      onLost: options.onLost,
      released: false,
      lost: false,
      lease: undefined as unknown as ReceiverLease,
    }
    const lease: ReceiverLease = {
      path,
      pid: holder.pid,
      token: holder.token,
      release: () => this.releaseReceiverLeaseFor(active),
    }
    // `lease` 는 active 의 release closure 가 참조하므로, 생성 후 연결한다.
    active.lease = lease
    this.receiverLease = active
    active.timer = setInterval(() => {
      void this.heartbeatReceiverLease(active)
    }, heartbeatMs)
    unrefTimer(active.timer)
    return lease
  }

  private async heartbeatReceiverLease(active: ActiveReceiverLease): Promise<void> {
    if (active.released || active.lost || this.receiverLease !== active) return

    let lost: Error | undefined
    try {
      await withLock(active.lease!.path, async () => {
        if (active.released || active.lost || this.receiverLease !== active) return
        const current = await readReceiverLease(active.lease!.path)
        if (current === undefined || current.token !== active.holder.token) {
          lost = receiverLeaseLostError(active.lease!.path)
          return
        }
        await writeReceiverLease(active.lease!.path, { ...current, heartbeatAt: this.now() })
      }, this.lockOptions())
    } catch (error) {
      lost = error instanceof Error ? error : new Error(String(error))
    }
    if (lost !== undefined) this.markReceiverLeaseLost(active, lost)
  }

  private async releaseReceiverLeaseFor(active: ActiveReceiverLease): Promise<boolean> {
    if (active.released) return false
    active.released = true
    if (active.timer !== undefined) clearInterval(active.timer)
    if (this.receiverLease === active) this.receiverLease = undefined

    return withLock(
      active.lease!.path,
      async () => {
        const current = await readReceiverLease(active.lease!.path)
        if (current === undefined || current.token !== active.holder.token) return false
        return unlinkExisting(active.lease!.path)
      },
      this.lockOptions(),
    )
  }

  private markReceiverLeaseLost(active: ActiveReceiverLease, error: Error): void {
    if (active.released || active.lost) return
    active.lost = true
    if (active.timer !== undefined) clearInterval(active.timer)
    if (this.receiverLease === active) this.receiverLease = undefined
    active.warn(`[agent-channel-mesh] receiver lease 를 잃었다: ${error.message}`)
    try {
      active.onLost?.(error)
    } catch (callbackError) {
      active.warn(
        `[agent-channel-mesh] receiver lease onLost 콜백이 실패했다: ${String(callbackError)}`,
      )
    }
  }

  /**
   * 한 건을 남긴다.
   *
   * 쓰는 김에 기한 경과분을 **파일에서 실제로 지운다**(§6.3). 표시만 지우면
   * 평문 바이트가 그대로 남아 보관 기한이 장식이 된다.
   *
   * 읽고-더하고-쓰는 전 구간이 채널 잠금 안이다. 밖에 두면 다른 프로세스의
   * `markDelivered` 가 같은 파일을 읽어 되쓰면서 방금 더한 것을 덮는다 —
   * 도착한 메시지가 흔적 없이 사라지고, 정본이라 선언한 곳의 유실이 된다.
   */
  async append(record: NewMessage): Promise<StoredMessage> {
    const channelId = requireChannelId(record.channelId)
    const direction = requireDirection(record.direction)
    const stored: StoredMessage = {
      id: normalizeId(record.id),
      channelId,
      direction,
      axis: requireAxis(record.axis),
      ...(record.senderKeyId !== undefined
        ? { senderKeyId: requireHex(record.senderKeyId, 'senderKeyId') }
        : {}),
      ...(record.senderLabel !== undefined ? { senderLabel: record.senderLabel } : {}),
      text: requireText(record.text),
      sentAt: requireTime(record.sentAt, 'sentAt'),
      storedAt: this.now(),
      ...(record.hops !== undefined ? { hops: requireHops(record.hops) } : {}),
      ...(record.authority !== undefined ? { authority: requireAuthority(record.authority) } : {}),
      ...(record.grant !== undefined ? { grant: requireGrant(record.grant) } : {}),
      ...(record.replyTo !== undefined ? { replyTo: requireHex(record.replyTo, 'replyTo') } : {}),
      ...(record.mute !== undefined ? { mute: requireMute(record.mute) } : {}),
      // 수신은 아직 세션에 닿지 않았고, 발신은 애초에 주입 대상이 아니다 (§6.6).
      delivered: direction === 'out',
    }

    return this.locked(channelId, async () => {
      const messages = this.fresh(await this.parse(channelId))
      messages.push(stored)
      sortByTime(messages)
      await this.write(channelId, this.trim(messages))
      return stored
    })
  }

  /**
   * 채널 기록을 시간순으로 읽는다.
   *
   * `limit` 은 **최신 쪽**을 남긴다 — 오래된 앞머리를 주면 방금 온 말을 못 본다.
   * 남긴 뒤에도 순서는 시간순이다 (§6.1 "시간순으로 묶어서").
   */
  async read(channelId: string, limit?: number): Promise<readonly StoredMessage[]> {
    const messages = await this.load(requireChannelId(channelId), true)
    return tail(messages, limit)
  }

  /**
   * 아직 세션에 전달되지 않은 것 (§6.6).
   *
   * 훅은 이것만 본다 — 그래야 주입이 도는 세션에서 훅이 조용하고, 주입이
   * 실패했거나 세션이 놓쳤을 때만 뜬다. 훅은 알림이 아니라 안전망이다.
   *
   * **조회다.** 선점 중인 것도 아직 전달되지 않았으므로 그대로 보인다. 이걸
   * 읽어서 곧바로 내보내면 다른 프로세스와 겹치므로, 실제로 내보낼 때는
   * {@link claimUndelivered} 를 쓴다.
   */
  async undelivered(channelId?: string, limit?: number): Promise<readonly StoredMessage[]> {
    const ids = channelId === undefined ? await this.channels() : [requireChannelId(channelId)]
    const out: StoredMessage[] = []
    for (const id of ids) {
      for (const m of await this.load(id, true)) if (!m.delivered) out.push(m)
    }
    sortByTime(out)
    return tail(out, limit)
  }

  /**
   * 내보낼 것을 **원자적으로 선점**하고 그 목록을 준다 (§6.6).
   *
   * `undelivered()` 로 읽고 나중에 `markDelivered()` 로 찍는 사이가 경합 창이다 —
   * 어댑터와 훅은 별개 프로세스라, 그 창에서 둘이 같은 메시지를 집으면 같은 말이
   * 세션에 두 번 간다. 여기서는 읽기와 선점 표시가 **한 잠금 안에서 함께** 일어나
   * 그 창이 없다. 이것이 §6.6 의 "중복은 지시문이 아니라 상태로 막는다"를
   * 프로세스 사이에서도 참으로 만드는 지점이다.
   *
   * 전달에 성공하면 {@link markDelivered}, 실패하면 {@link release} 다. 어느 쪽도
   * 못 부르고 죽으면 {@link DEFAULT_CLAIM_TTL_MS} 뒤에 저절로 풀린다.
   *
   * `limit` 은 **오래된 것부터** 준다 — 밀린 큐를 내보내는 동작이라 앞머리를 계속
   * 건너뛰면 오래된 것이 굶는다(`undelivered` 의 `limit` 은 최신 쪽을 남기는 조회
   * 의미이고, 여기는 배달 순서다).
   *
   * **채널 잠금은 하나씩 잡았다 놓는다.** 두 개를 겹쳐 들면 반대 순서로 도는
   * 프로세스와 교착한다.
   */
  async claimUndelivered(channelId?: string, limit?: number): Promise<readonly StoredMessage[]> {
    const ids = channelId === undefined ? await this.channels() : [requireChannelId(channelId)]
    if (limit !== undefined) requireLimit(limit)

    const claimed: StoredMessage[] = []
    for (const id of ids) {
      const room = limit === undefined ? undefined : limit - claimed.length
      if (room !== undefined && room <= 0) break
      claimed.push(...(await this.claimIn(id, room)))
    }
    sortByTime(claimed)
    return claimed
  }

  /**
   * 선점을 푼다. 실제로 풀린 개수를 준다.
   *
   * 전달에 실패했을 때 쓴다. 이걸 안 부르면 리스 기한만큼 그 메시지가 안 나오는데,
   * 그건 유실은 아니지만 §6.6 이 훅에 맡긴 안전망이 그 시간만큼 늦게 뜬다는 뜻이다.
   */
  async release(ids: readonly string[]): Promise<number> {
    return this.rewriteByIds(ids, m => (m.claimedAt === undefined ? undefined : stripClaim(m)))
  }

  /**
   * 전달된 것으로 표시하고, **실제로 바뀐 개수**를 준다.
   *
   * 선점도 함께 푼다 — 전달이 확정된 뒤의 리스는 아무 의미가 없고, 남겨 두면
   * 파일에 죽은 상태가 쌓인다.
   */
  async markDelivered(ids: readonly string[]): Promise<number> {
    return this.rewriteByIds(ids, m =>
      m.delivered ? undefined : { ...stripClaim(m), delivered: true },
    )
  }

  /**
   * 채널 기록을 지운다. 파일이 있었으면 `true`.
   *
   * `unlink` 다 — 걸러서 다시 쓰지 않는다. 권한 검사도 걸지 않는데, 권한이
   * 넓어진 파일이야말로 지울 수 있어야 하고 삭제는 내용을 읽지 않기 때문이다.
   * 같은 이유로 디렉토리를 만들지도 않는다 — 없으면 지울 것도 없다.
   *
   * 그럼에도 잠금은 잡는다. 다른 프로세스가 읽고-고치는 중에 파일이 사라지면
   * 그 프로세스는 지운 대화를 **되살려 쓴다** — "삭제는 실제 삭제다"(§6.3)가
   * 경합 한 번으로 뒤집힌다.
   */
  async purge(channelId: string): Promise<boolean> {
    const file = this.pathOf(channelId)
    try {
      return await withLock(file, () => unlinkExisting(file), this.lockOptions())
    } catch (e) {
      // 잠금 파일조차 못 만든다 = 저장 디렉토리가 없다 = 지울 것이 없다.
      if (isMissing(e)) return false
      throw e
    }
  }

  /** 기록이 있는 채널 id 들. */
  async channels(): Promise<readonly string[]> {
    let names: string[]
    try {
      // 목록을 읽기 **전에** 디렉토리 권한을 본다. MAX_DIR_MODE 를 둔 근거가
      // "목록만 읽혀도 채널 id 가 샌다"인데, 정작 목록을 읽는 여기가 검사를
      // 건너뛰면 그 방어가 쓰기 경로에만 걸린 절반이 된다.
      await this.assertDir()
      names = await readdir(this.dir)
    } catch (e) {
      if (isMissing(e)) return []
      throw e
    }
    const out = names.map(n => CHANNEL_FILE.exec(n)?.[1]).filter((v): v is string => v !== undefined)
    out.sort()
    return out
  }

  /** 이 채널 기록이 있을 자리. 테스트·진단이 디스크를 직접 확인할 때 쓴다. */
  pathOf(channelId: string): string {
    return join(this.dir, `${requireChannelId(channelId)}.json`)
  }

  /**
   * 파일을 읽고 기한 경과분을 떨어낸다.
   *
   * `persist` 면 떨어낸 결과를 되쓴다 — §6.3 의 "삭제는 실제 삭제다"가 읽기
   * 경로에서도 성립해야 한다. 읽을 때만 걸러 보여주면 파일에는 남는다.
   *
   * **잠금은 실제로 되쓸 때만 잡는다.** 순수 읽기까지 직렬화하면 조망 UI 하나가
   * 도착 처리를 막는다. 되쓸 것이 있으면 잠금 안에서 **다시 읽고** 다시 거른다 —
   * 잠금 밖에서 읽은 목록을 그대로 쓰면 그 사이에 append 된 것을 덮는다.
   */
  private async load(channelId: string, persist = false): Promise<StoredMessage[]> {
    const messages = await this.parse(channelId)
    const fresh = this.fresh(messages)
    if (!persist || fresh.length === messages.length) return fresh

    return this.locked(channelId, async () => {
      const again = await this.parse(channelId)
      const kept = this.fresh(again)
      if (kept.length !== again.length) await this.write(channelId, kept)
      return kept
    })
  }

  /**
   * 채널 잠금 안에서 돌린다. 변경 경로 전용이다 (src/store/lock.ts).
   *
   * 잠금 파일이 저장 디렉토리에 생기므로, 첫 쓰기처럼 디렉토리가 아직 없을 수
   * 있는 경로를 위해 `ensureDir` 을 함께 넘긴다 — 권한 검사도 거기서 같이 돈다.
   */
  private async locked<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    return withLock(this.pathOf(channelId), fn, {
      ...this.lockOptions(),
      ensureDir: () => this.ensureDir(),
    })
  }

  private lockOptions(): { staleMs?: number; timeoutMs?: number } {
    return {
      ...(this.lockStaleMs !== undefined ? { staleMs: this.lockStaleMs } : {}),
      ...(this.lockTimeoutMs !== undefined ? { timeoutMs: this.lockTimeoutMs } : {}),
    }
  }

  /**
   * 한 채널에서 미전달·미선점분을 선점한다. 잠금 안에서 읽고 찍는다.
   *
   * 기한 지난 선점은 여기서 **풀린 것으로 본다**. 선점하고 죽은 프로세스의
   * 메시지가 영영 안 나오면, 훅이라는 안전망을 선점 표시 하나가 막는다.
   */
  private async claimIn(channelId: string, room?: number): Promise<StoredMessage[]> {
    return this.locked(channelId, async () => {
      const raw = await this.parse(channelId)
      const messages = this.fresh(raw)
      const now = this.now()
      const taken: StoredMessage[] = []
      const next = messages.map(m => {
        if (m.delivered) return m
        if (m.claimedAt !== undefined && now - m.claimedAt < this.claimTtl) return m
        if (room !== undefined && taken.length >= room) return m
        const leased: StoredMessage = { ...m, claimedAt: now }
        taken.push(leased)
        return leased
      })
      // 선점이 없어도 기한 경과분이 떨어져 나갔으면 그 삭제는 확정해야 한다.
      if (taken.length > 0 || messages.length !== raw.length) await this.write(channelId, next)
      return taken
    })
  }

  /**
   * 주어진 id 들을 채널마다 찾아 고쳐 쓴다. 실제로 바뀐 개수를 준다.
   *
   * `change` 가 `undefined` 를 주면 그 레코드는 손대지 않는다. `markDelivered` 와
   * `release` 가 같은 골격을 쓰게 두는 이유는, 잠금 범위·채널 순회·되쓰기 조건이
   * 갈리면 한쪽만 고쳐져 그쪽이 조용히 경합에 열리기 때문이다.
   */
  private async rewriteByIds(
    ids: readonly string[],
    change: (m: StoredMessage) => StoredMessage | undefined,
  ): Promise<number> {
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0

    let changed = 0
    // 채널을 하나씩 잡았다 놓는다 — 두 개를 겹쳐 들면 교착이다.
    for (const channelId of await this.channels()) {
      changed += await this.locked(channelId, async () => {
        const messages = this.fresh(await this.parse(channelId))
        let touched = 0
        const next = messages.map(m => {
          if (!wanted.has(m.id)) return m
          const replaced = change(m)
          if (replaced === undefined) return m
          touched += 1
          return replaced
        })
        if (touched > 0) await this.write(channelId, next)
        return touched
      })
    }
    return changed
  }

  /** 기한 경과분을 떨어낸다. 순서는 시간순으로 맞춘다. */
  private fresh(messages: StoredMessage[]): StoredMessage[] {
    const cutoff = this.now() - this.retention
    const kept = messages.filter(m => m.storedAt >= cutoff)
    sortByTime(kept)
    return kept
  }

  /** 파일을 읽어 형태를 검사한다. 거르지도, 되쓰지도 않는다. */
  private async parse(channelId: string): Promise<StoredMessage[]> {
    const file = this.pathOf(channelId)
    let raw: string
    try {
      // 파일이 0600 이어도 디렉토리가 넓으면 평문은 이미 남에게 열려 있다.
      // 검사를 쓰기 경로에만 걸면 §10.14 가 0700/0600 에 맡긴 방어가 읽기로
      // 그대로 뚫린다 — 두 경로가 같은 기준을 봐야 방어가 성립한다.
      await this.assertDir()
      await assertMode(file, MAX_FILE_MODE, '저장 파일', '대화 평문이 들어 있으므로 chmod 600')
      raw = await readFile(file, 'utf8')
    } catch (e) {
      // 디렉토리·파일이 아예 없는 것은 위반이 아니다 — 기록이 없을 뿐이다.
      if (isMissing(e)) return []
      throw e
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      // 조용히 빈 배열로 넘어가면 손상된 파일 위에 새 기록을 덮어써서
      // 남아 있던 대화를 우리 손으로 지우게 된다.
      throw new Error(`저장 파일이 손상됐다: ${file} (${String(e)})`)
    }
    return parseFile(parsed, file, channelId)
  }

  /** 개수 상한. 넘으면 오래된 것부터 버린다 — 새 것을 거부하지 않는다. */
  private trim(messages: StoredMessage[]): StoredMessage[] {
    return messages.length <= this.maxPerChannel
      ? messages
      : messages.slice(messages.length - this.maxPerChannel)
  }

  /**
   * 임시 파일에 쓰고 `rename` 한다.
   *
   * 쓰는 도중에 죽으면 반쪽 JSON 이 남고, 그건 다음 읽기에서 손상으로 죽는다.
   * 임시 파일을 **같은 디렉토리**에 두는 이유는 크로스 디바이스 rename 이
   * 원자적이지 않아서다 — 그때는 복사 후 삭제가 되어 보장이 사라진다.
   */
  private async write(channelId: string, messages: readonly StoredMessage[]): Promise<void> {
    await this.ensureDir()
    const file = this.pathOf(channelId)
    const body: ChannelFile = { version: FORMAT_VERSION, channelId, messages }
    const tmp = `${file}.${randomHex(8)}.tmp`
    await writeFile(tmp, JSON.stringify(body), { mode: MAX_FILE_MODE })
    // writeFile 의 mode 는 umask 로 **좁아질 뿐** 넓어지지 않지만, 그건 새로
    // 만들 때 얘기다. rename 전에 확정해 두면 어느 경로로 와도 0600 이다.
    await chmod(tmp, MAX_FILE_MODE)
    await rename(tmp, file)
  }

  /**
   * 저장 디렉토리 권한을 검사한다. 없으면 ENOENT 를 그대로 올린다.
   *
   * 읽기 경로(`load`·`channels`)와 쓰기 경로(`ensureDir`)가 **같은 함수**를
   * 부르게 둔다. 검사 문구를 각자 들고 있으면 한쪽만 고쳐져 기준이 갈리고,
   * 갈린 쪽이 조용히 느슨해진다.
   */
  private async assertDir(): Promise<void> {
    await assertMode(this.dir, MAX_DIR_MODE, '저장 디렉토리', '채널 목록이 새므로 chmod 700')
  }

  /** 디렉토리를 0700 으로 확보한다. 이미 있으면 권한을 검사한다. */
  private async ensureDir(): Promise<void> {
    try {
      await this.assertDir()
      return
    } catch (e) {
      if (!isMissing(e)) throw e
    }
    await mkdir(this.dir, { recursive: true, mode: MAX_DIR_MODE })
    // mkdir 의 mode 는 umask 에 깎인다. 갓 만든 디렉토리에만 확정한다 —
    // 이미 있던 디렉토리는 위 검사를 통과한 것이므로 손대지 않는다.
    await chmod(this.dir, MAX_DIR_MODE)
  }
}

/**
 * 권한을 검사한다. 넓으면 **읽지 않고 던진다.**
 *
 * 설정 파일(src/adapter/config.ts)과 같은 톤이고 같은 이유다 — 경고로 완화하면
 * 지켜지지 않고, 지켜지지 않은 것이 조용히 동작한다.
 */
async function assertMode(path: string, max: number, what: string, remedy: string): Promise<void> {
  const found = (await stat(path)).mode & 0o777
  if ((found & ~max) !== 0) {
    throw new Error(
      `${what} 권한이 너무 넓다 — ${path} (권한 ${found.toString(8).padStart(3, '0')}). ` +
        `${remedy} 으로 좁혀라.`,
    )
  }
}

/**
 * 파일 형태를 검사한다. 어긋나면 조용히 반쪽으로 읽지 않고 죽는다.
 *
 * 디스크에서 온 것은 **다시 들어오는 입력**이다. 쓸 때 한 번 검사했다는 이유로
 * 읽을 때 믿으면, 그 사이에 파일을 고친 무엇이든 검사를 통과한다.
 *
 * `channelId`(파일 이름에서 온 것)를 받아 레코드가 주장하는 채널과 대조한다.
 * §6.4 는 축과 채널을 **저장 시점에 확정**하라고 정하는데, `aa11.json` 안의
 * 레코드가 `bb22` 를 주장하면 조망 UI 가 그 대화를 다른 채널로 귀속한다 —
 * 축이 갈리는 자리가 정확히 거기라, 조용한 오귀속이 §6.4 가 막으려던 사고다.
 */
function parseFile(parsed: unknown, file: string, channelId: string): StoredMessage[] {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`저장 파일이 객체가 아니다: ${file}`)
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.version !== 'number' || !READABLE_VERSIONS.has(o.version)) {
    throw new Error(`모르는 저장 형식이다: ${file} (version ${String(o.version)})`)
  }
  if (!Array.isArray(o.messages)) throw new Error(`저장 파일에 messages 배열이 없다: ${file}`)

  return o.messages.map((m, i) => {
    if (typeof m !== 'object' || m === null) {
      throw new Error(`messages[${i}] 가 객체가 아니다: ${file}`)
    }
    const r = m as Record<string, unknown>
    const { id, channelId: claimed, senderKeyId, senderLabel, text, sentAt, storedAt, replyTo } = r
    if (typeof id !== 'string' || typeof claimed !== 'string' || typeof text !== 'string') {
      throw new Error(`messages[${i}] 형태가 어긋난다: ${file}`)
    }
    if (typeof sentAt !== 'number' || typeof storedAt !== 'number') {
      throw new Error(`messages[${i}] 의 시각이 숫자가 아니다: ${file}`)
    }
    if (claimed !== channelId) {
      throw new Error(
        `messages[${i}] 가 다른 채널을 주장한다: ${file} ` +
          `(파일은 ${channelId}, 레코드는 ${claimed.slice(0, 64)}). 대화가 오귀속된다 (§6.4).`,
      )
    }
    if (senderLabel !== undefined && typeof senderLabel !== 'string') {
      throw new Error(`messages[${i}] 의 senderLabel 이 문자열이 아니다: ${file}`)
    }
    // 스프레드로 받지 않는다 — 모르는 필드가 그대로 통과하면 이 검사가
    // 형태를 보장한다는 말이 거짓이 되고, 그 필드는 소비자마다 다르게 읽힌다.
    return {
      // 쓰기 경로(`normalizeId`)와 **같은** `requireHex` 를 태운다. 읽기용 완화판을
      // 따로 두면 검사가 갈리고, 갈린 자리로 이 비대칭이 그대로 되돌아온다.
      // id 는 `markDelivered` 의 매칭 키이자 `inbox`·훅·조망 UI 로 나가는 표시 값이다.
      id: requireHex(id, `messages[${i}].id`),
      channelId,
      direction: requireDirection(r.direction),
      axis: requireAxis(r.axis),
      ...(senderKeyId !== undefined
        ? { senderKeyId: requireHex(senderKeyId, `messages[${i}].senderKeyId`) }
        : {}),
      ...(senderLabel !== undefined ? { senderLabel } : {}),
      text,
      sentAt,
      storedAt,
      ...(r.hops !== undefined ? { hops: requireHops(r.hops) } : {}),
      // 버전 1·2 파일에는 없다. 없으면 동료로 읽힌다(`recordAuthority`) —
      // 옛 파일이 조용히 내 권한을 얻는 일이 없어야 한다.
      ...(r.authority !== undefined
        ? { authority: requireAuthority(r.authority, `messages[${i}].authority`) }
        : {}),
      ...(r.grant !== undefined ? { grant: requireGrant(r.grant, `messages[${i}].grant`) } : {}),
      ...(replyTo !== undefined ? { replyTo: requireHex(replyTo, `messages[${i}].replyTo`) } : {}),
      ...(r.mute !== undefined ? { mute: requireMute(r.mute, `messages[${i}].mute`) } : {}),
      delivered: r.delivered === true,
      // 버전 1 파일에는 없다. 없으면 "선점되지 않음"이고, 그게 맞는 해석이다.
      ...(r.claimedAt !== undefined
        ? { claimedAt: requireTime(r.claimedAt, `messages[${i}].claimedAt`) }
        : {}),
    }
  })
}

/** 최신 쪽 `limit` 개. 자른 뒤에도 순서는 시간순 그대로다. */
function tail(messages: readonly StoredMessage[], limit?: number): readonly StoredMessage[] {
  if (limit === undefined) return messages
  requireLimit(limit)
  return messages.slice(Math.max(0, messages.length - limit))
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`limit 은 0 이상의 정수다: ${String(limit)}`)
  }
  return limit
}

/**
 * 선점 표시를 뗀 사본. 필드를 `undefined` 로 남기지 않고 **없앤다**.
 *
 * `claimedAt: undefined` 를 그대로 쓰면 JSON 에서는 키가 사라지지만 메모리의
 * 객체에는 남아, 같은 레코드가 경로마다 다른 모양으로 보인다. 없음은 없음이다.
 */
function stripClaim(m: StoredMessage): StoredMessage {
  if (m.claimedAt === undefined) return m
  const { claimedAt: _dropped, ...rest } = m
  return rest
}

/** 있으면 지우고 `true`. 없으면 `false` — 없다는 사실이 오류는 아니다. */
async function unlinkExisting(file: string): Promise<boolean> {
  try {
    await unlink(file)
    return true
  } catch (e) {
    if (isMissing(e)) return false
    throw e
  }
}

/** 시간순(오름차순). 같은 시각이면 저장 순, 그다음 id — 자르는 자리가 흔들리지 않게. */
function sortByTime(messages: StoredMessage[]): void {
  messages.sort(
    (a, b) =>
      a.sentAt - b.sentAt || a.storedAt - b.storedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** 경로 조작을 막는다. 채널 id 는 태그 hex 이므로 이 형태를 벗어날 이유가 없다. */
function requireChannelId(value: string): string {
  if (typeof value !== 'string' || !CHANNEL_ID.test(value)) {
    throw new Error(`채널 id 가 올바르지 않다: ${String(value).slice(0, 32)}… (소문자 hex 2~64자)`)
  }
  return value
}

function requireDirection(value: unknown): Direction {
  if (value !== 'in' && value !== 'out') {
    throw new Error(`direction 은 in·out 중 하나다: ${String(value)}`)
  }
  return value
}

function requireAxis(value: unknown): Axis {
  if (value !== 'external' && value !== 'internal' && value !== 'local') {
    throw new Error(`axis 는 external·internal·local 중 하나다: ${String(value)}`)
  }
  return value
}

// 축과 같은 톤으로 좁힌다. 모르는 값을 통과시키면 그 순간 이 필드는 권한
// 판정의 근거가 아니라 발신자가 고르는 문자열이 된다.
function requireAuthority(value: unknown, what = 'authority'): Authority {
  if (value !== 'self' && value !== 'peer') {
    throw new Error(`${what} 는 self·peer 중 하나다: ${String(value)}`)
  }
  return value
}

function requireGrant(value: unknown, what = 'grant'): Grant {
  if (!isGrant(value)) {
    throw new Error(`${what} 은 read·write·execute 중 하나다: ${String(value)}`)
  }
  return value
}

function requireText(value: string): string {
  if (typeof value !== 'string') throw new Error('text 는 문자열이어야 한다')
  return value
}

// 디스크에서 온 값(`unknown`)과 쓰기 경로의 값이 **같은 검사**를 타야 한다.
function requireTime(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what} 은 epoch ms 숫자여야 한다: ${String(value)}`)
  }
  return value
}

// 아래 셋은 `unknown` 을 받는다 — 쓰기 경로(타입이 이미 좁다)와 읽기 경로(디스크에서
// 온 `unknown`)가 **같은 검사**를 타야 한다. 읽기용 완화판을 따로 두면 그쪽이 느슨해진다.
function requireHops(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`hops 는 0 이상의 정수다: ${String(value)}`)
  }
  return value
}

/** 바이트 값은 전부 hex 로 받는다 — `Uint8Array` 는 JSON 을 타면 뭉개진다. */
function requireHex(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX.test(value) || value.length % 2 !== 0) {
    throw new Error(`${what} 은 소문자 hex 여야 한다: ${String(value).slice(0, 32)}…`)
  }
  return value
}

/**
 * 발화 판정 사유 (§7). **빈 문자열은 거부한다.**
 *
 * 소비자는 이 값을 `[응답 안 함: <사유>]` 로 렌더한다 — 비어 있으면 표시가
 * 남되 이유가 사라져, 모델이 "왜 답하면 안 되는지"를 알 수 없는 꼬리표만 본다.
 * 사유 없는 침묵 표시는 §7 을 설명하지 못하므로, 없을 거면 필드가 없어야 한다.
 */
function requireMute(value: unknown, what = 'mute'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} 는 비어 있지 않은 문자열이어야 한다: ${String(value).slice(0, 32)}…`)
  }
  return value
}

function normalizeId(id: string | undefined): string {
  return id === undefined ? randomHex(16) : requireHex(id, 'id')
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

/** 저장소 전체 receiver lease 파일의 경로. 채널 파일 규칙과 분리된 이름을 쓴다. */
export function receiverLeasePathOf(directory: string): string {
  return join(expandHome(directory), RECEIVER_LEASE_FILE)
}

function requireReceiverLeaseDuration(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} 은 유한한 양수여야 한다: ${String(value)}`)
  }
  return value
}

/** 수신 lease 파일을 만들 때만 O_EXCL 로 경합을 판정한다. */
async function createReceiverLease(path: string, holder: ReceiverLeaseHolder): Promise<void> {
  const file = await open(path, 'wx', MAX_FILE_MODE)
  try {
    try {
      await file.writeFile(JSON.stringify(holder))
      await file.chmod(MAX_FILE_MODE)
    } catch (error) {
      await unlinkExisting(path)
      throw error
    }
  } finally {
    await file.close()
  }
}

/** heartbeat 갱신은 임시 파일과 rename 으로 반쪽 JSON 을 만들지 않는다. */
async function writeReceiverLease(path: string, holder: ReceiverLeaseHolder): Promise<void> {
  const tmp = `${path}.${randomHex(8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(holder), { mode: MAX_FILE_MODE })
    await chmod(tmp, MAX_FILE_MODE)
    await rename(tmp, path)
  } finally {
    await unlinkExisting(tmp)
  }
}

/** lease 파일을 검증해서 읽는다. 손상 파일은 stale 판정을 위해 undefined 로 돌린다. */
async function readReceiverLease(path: string): Promise<ReceiverLeaseHolder | undefined> {
  let raw: string
  try {
    await assertMode(path, MAX_FILE_MODE, 'receiver lease 파일', 'chmod 600')
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = parsed as Record<string, unknown>
  if (
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid < 0 ||
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    typeof value.acquiredAt !== 'number' ||
    !Number.isFinite(value.acquiredAt) ||
    typeof value.heartbeatAt !== 'number' ||
    !Number.isFinite(value.heartbeatAt)
  ) {
    return undefined
  }
  return {
    pid: value.pid,
    token: value.token,
    acquiredAt: value.acquiredAt,
    heartbeatAt: value.heartbeatAt,
  }
}

/** 정상 lease 또는 손상 lease 의 마지막 갱신 시각으로 stale 여부를 계산한다. */
async function receiverLeaseAge(
  path: string,
  holder: ReceiverLeaseHolder | undefined,
  now: () => number,
): Promise<number | undefined> {
  if (holder !== undefined) return Math.max(0, now() - holder.heartbeatAt)
  try {
    return Math.max(0, now() - (await stat(path)).mtimeMs)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function receiverLeaseLostError(path: string): Error {
  const error = new Error(`receiver lease 파일의 소유권이 바뀌었다: ${path}`)
  error.name = 'ReceiverLeaseLostError'
  return error
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref
  maybeUnref?.call(timer)
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * `~` 를 홈으로 편다.
 *
 * 어댑터에도 같은 함수가 있지만 거기서 가져오지 않는다 — 코어가 어댑터를
 * import 하면 의존 방향이 뒤집혀, 코어만 쓰는 소비자가 어댑터를 끌고 온다.
 * 한 줄짜리 중복이 잘못된 방향의 의존보다 싸다.
 */
function expandHome(path: string, home = process.env.HOME ?? ''): string {
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
}
