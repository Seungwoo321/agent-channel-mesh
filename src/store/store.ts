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
 */
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

/** 저장 파일의 최대 허용 권한. 설정 파일(§11)과 같은 기준이다. */
const MAX_FILE_MODE = 0o600

/** 저장 디렉토리의 최대 허용 권한. 목록만 읽혀도 채널 id 가 새므로 함께 막는다. */
const MAX_DIR_MODE = 0o700

/** 파일 형식 버전. 형식을 바꿀 때 조용히 오해석하지 않으려고 둔다. */
const FORMAT_VERSION = 1

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
}

/** 저장을 요청할 때 주는 것. `storedAt`·`delivered` 는 저장소가 정한다. */
export interface NewMessage extends Omit<StoredMessage, 'id' | 'storedAt' | 'delivered'> {
  /** 없으면 새로 뽑는다. 수신은 봉투의 messageId 를 그대로 넣는다. */
  readonly id?: string
}

export interface StoreOptions {
  readonly dir?: string
  readonly retentionMs?: number
  readonly maxPerChannel?: number
  /** 지금 시각. 테스트에서만 주입한다. */
  readonly now?: () => number
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
  private readonly now: () => number

  constructor(options: StoreOptions = {}) {
    this.dir = expandHome(options.dir ?? DEFAULT_STORE_DIR)
    this.retention = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.maxPerChannel = options.maxPerChannel ?? DEFAULT_MAX_PER_CHANNEL
    this.now = options.now ?? Date.now
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

  /**
   * 한 건을 남긴다.
   *
   * 쓰는 김에 기한 경과분을 **파일에서 실제로 지운다**(§6.3). 표시만 지우면
   * 평문 바이트가 그대로 남아 보관 기한이 장식이 된다.
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
      ...(record.replyTo !== undefined ? { replyTo: requireHex(record.replyTo, 'replyTo') } : {}),
      ...(record.mute !== undefined ? { mute: requireMute(record.mute) } : {}),
      // 수신은 아직 세션에 닿지 않았고, 발신은 애초에 주입 대상이 아니다 (§6.6).
      delivered: direction === 'out',
    }

    const messages = await this.load(channelId)
    messages.push(stored)
    sortByTime(messages)
    await this.write(channelId, this.trim(messages))
    return stored
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

  /** 전달된 것으로 표시하고, **실제로 바뀐 개수**를 준다. */
  async markDelivered(ids: readonly string[]): Promise<number> {
    const wanted = new Set(ids)
    if (wanted.size === 0) return 0

    let marked = 0
    for (const channelId of await this.channels()) {
      const messages = await this.load(channelId, true)
      let touched = false
      const next = messages.map(m => {
        if (m.delivered || !wanted.has(m.id)) return m
        touched = true
        marked += 1
        return { ...m, delivered: true }
      })
      if (touched) await this.write(channelId, next)
    }
    return marked
  }

  /**
   * 채널 기록을 지운다. 파일이 있었으면 `true`.
   *
   * `unlink` 다 — 걸러서 다시 쓰지 않는다. 권한 검사도 걸지 않는데, 권한이
   * 넓어진 파일이야말로 지울 수 있어야 하고 삭제는 내용을 읽지 않기 때문이다.
   */
  async purge(channelId: string): Promise<boolean> {
    try {
      await unlink(this.pathOf(channelId))
      return true
    } catch (e) {
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
   * `append` 경로에서는 어차피 뒤이어 쓰므로 되쓰지 않는다.
   */
  private async load(channelId: string, persist = false): Promise<StoredMessage[]> {
    const file = this.pathOf(channelId)
    let raw: string
    try {
      // 파일이 0600 이어도 디렉토리가 넓으면 평문은 이미 남에게 열려 있다.
      // 검사를 쓰기 경로에만 걸면 §10.13 이 0700/0600 에 맡긴 방어가 읽기로
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
    const messages = parseFile(parsed, file, channelId)

    const cutoff = this.now() - this.retention
    const fresh = messages.filter(m => m.storedAt >= cutoff)
    sortByTime(fresh)
    if (persist && fresh.length !== messages.length) await this.write(channelId, fresh)
    return fresh
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
  if (o.version !== FORMAT_VERSION) {
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
      ...(replyTo !== undefined ? { replyTo: requireHex(replyTo, `messages[${i}].replyTo`) } : {}),
      ...(r.mute !== undefined ? { mute: requireMute(r.mute, `messages[${i}].mute`) } : {}),
      delivered: r.delivered === true,
    }
  })
}

/** 최신 쪽 `limit` 개. 자른 뒤에도 순서는 시간순 그대로다. */
function tail(messages: readonly StoredMessage[], limit?: number): readonly StoredMessage[] {
  if (limit === undefined) return messages
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`limit 은 0 이상의 정수다: ${String(limit)}`)
  }
  return messages.slice(Math.max(0, messages.length - limit))
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

function requireText(value: string): string {
  if (typeof value !== 'string') throw new Error('text 는 문자열이어야 한다')
  return value
}

function requireTime(value: number, what: string): number {
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
