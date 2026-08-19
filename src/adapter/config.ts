/**
 * 어댑터 설정 — 파일에서 노드를 세운다
 *
 * 설계 근거는 docs/architecture.md §4「어댑터」· §11「설정」.
 *
 * 어댑터는 에이전트가 띄우는 stdio 서브프로세스다. 대화창이 없으므로
 * 시드도 채널 비밀도 물어볼 수 없고, 프로세스가 재시작될 때마다 신원이
 * 바뀌면 지문 검증(§9)이 무의미해진다. 그래서 **파일이 유일한 입력**이다.
 *
 * 이 파일에는 개인키(시드)와 채널 비밀이 들어간다 — 그 둘이면 과거·미래
 * 메시지를 전부 읽을 수 있다. 따라서 로드할 때 권한을 **검사해서 막는다**.
 * 문서로만 경고하면 지켜지지 않고, 지켜지지 않은 것이 조용히 동작한다.
 */
import { deriveIdentity, type Identity } from '../identity/keys.js'
import { Channel } from '../channel/channel.js'
import { MeshNode } from '../node/node.js'
import { RelayClient } from '../relay/client.js'
import { DEFAULT_STORE_DIR, type Axis, type StoreOptions } from '../store/store.js'
import { fingerprint, parseKey, toHex, toKey } from '../identity/fingerprint.js'
import { buildPolicy, GRANTS } from '../policy/authority.js'

/** 기본 설정 위치. `ACM_CONFIG` 로 덮어쓴다. */
export const DEFAULT_CONFIG_PATH = '~/.agent-channel-mesh/config.json'

/** 설정 파일의 최대 허용 권한. 그룹·타인에게 한 비트도 열려 있으면 안 된다. */
const MAX_MODE = 0o600

export interface MemberConfig {
  /** 사람이 부르는 이름. 신뢰의 근거가 아니다 — 근거는 지문뿐이다 (§9). */
  readonly label?: string
  /** Ed25519 서명 공개키 (hex). */
  readonly sign: string
  /** X25519 KEM 공개키 (hex). */
  readonly kem: string
}

export interface ChannelConfig {
  /** 채널 비밀 32B (hex). 이것을 아는 것이 곧 멤버십이다 (§10.11). */
  readonly secret: string
  readonly name?: string
  readonly members: readonly MemberConfig[]
  /** 내가 응답할 이름들. 비우면 모든 메시지에 응답한다 (§7). */
  readonly mentions?: readonly string[]
  readonly maxHops?: number
  readonly messageBudget?: number
  /**
   * 이 채널이 남이냐 내 다른 세션이냐 (§6.4).
   *
   * 생략하면 `external` 이다. 안전한 쪽으로 기운다 — 내부를 외부로 잘못
   * 표시하면 홉 제한이 더 세게 걸릴 뿐이지만, 반대는 §7 을 우회시킨다.
   */
  readonly axis?: Axis
}

/**
 * 로컬 저장소 설정 (§6.3).
 *
 * 저장소는 코어가 소유하지만 그 값을 정하는 입구는 여기다 — 어댑터의 유일한
 * 입력이 설정 파일이므로(§11), 여기에 자리가 없으면 사용자는 보관 기한을
 * 바꿀 방법이 아예 없다. 전부 선택이고, 생략하면 `MessageStore` 의 기본값이다.
 */
export interface StoreConfig {
  /**
   * 저장 위치의 **바깥 디렉토리**. 생략하면 설정 파일 옆
   * (`~/.agent-channel-mesh/messages`). 실제 파일은 언제나 그 아래
   * 지문 디렉토리에 들어간다 ({@link storeOptionsOf}).
   */
  readonly dir?: string
  /** 보관 기한(ms). 유한한 양수여야 한다 — 무제한은 열어 두지 않는다 (§6.3). */
  readonly retentionMs?: number
  /** 채널당 보관 개수 상한. 기한과 별개로 파일 크기를 묶어 둔다. */
  readonly maxPerChannel?: number
}

/**
 * 설정 파일의 저장소 설정을 `MessageStore` 옵션으로 옮긴다.
 *
 * 이름이 같아도 **명시로 옮긴다.** 스프레드로 넘기면 두 타입이 우연히 겹쳐
 * 있는 동안만 맞고, 한쪽이 필드를 늘리거나 이름을 바꾸는 순간 조용히
 * 어긋난다 — 타입 검사는 통과하고 값만 사라지는 종류의 고장이다.
 * `undefined` 를 넣지 않고 키 자체를 빼는 이유도 같다: `{dir: undefined}` 는
 * `??` 기본값을 타지만, `exactOptionalPropertyTypes` 아래서는 타입이 갈린다.
 *
 * `~` 는 펴지 않는다 — `MessageStore` 생성자가 이미 편다. 여기서 한 번 더
 * 펴면 확장 규칙이 두 곳에 생기고, 갈리면 한쪽이 틀린다.
 *
 * **여기가 유일한 자리다.** 어댑터(`bin.ts`)와 훅(`install/notify.ts`)이 같은
 * 저장소를 봐야 하는데 각자 옮기면, 사용자가 `store.dir` 을 바꾼 순간 둘이
 * 다른 디렉토리를 보고 훅이 영원히 조용해진다.
 *
 * **디렉토리는 신원에서 파생한다.** 한 기계에서 에이전트마다 설정 파일을
 * 갈라도(`ACM_CONFIG`) 저장 위치가 상수면 두 신원이 같은 채널 파일에 쓴다 —
 * 실측된 고장이다: 코덱스의 `inbox` 가 코덱스가 보낸 말을 자기 수신함에서
 * 읽었다. 이것이 §6.3 이 막으라는 오배달이고, `delivered` 상태까지 공유돼
 * 한쪽이 받으면 다른 쪽에서 사라진다. 그래서 바깥 디렉토리를 사용자가 바꾸든
 * 말든 그 아래 지문 디렉토리는 **항상** 붙인다 — 설정으로 뚫을 수 없어야
 * 손으로 맞출 것이 하나 줄어든다.
 */
export function storeOptionsOf(store: StoreConfig | undefined, identity: Identity): StoreOptions {
  const base = store?.dir ?? DEFAULT_STORE_DIR
  return {
    dir: `${base}/${toKey(identity.fingerprint)}`,
    ...(store?.retentionMs !== undefined ? { retentionMs: store.retentionMs } : {}),
    ...(store?.maxPerChannel !== undefined ? { maxPerChannel: store.maxPerChannel } : {}),
  }
}

/**
 * 설정에서 신원을 뽑는다.
 *
 * {@link buildNode} 와 같은 파생을 훅도 해야 한다 — 훅은 노드를 세우지 않고
 * 저장소만 열지만, 그 저장소 경로가 이제 지문에 달려 있다. 파생을 두 곳에
 * 적으면 갈리는 날 훅이 빈 디렉토리를 열고 영원히 조용해진다.
 */
export async function identityOf(config: Config): Promise<Identity> {
  return await deriveIdentity(fromHex(config.seed, 32))
}

/**
 * 발신자별 권한 정책 (§8.2).
 *
 * 프롬프트 파일(`CLAUDE.md` 류)이 아니라 이 파일에 두는 이유는 두 가지다 —
 * 프롬프트 룰은 컨텍스트가 압축되면 사라지고(§6.1), 모델이 무시해도 막을
 * 방법이 없다. 여기 적힌 값은 훅이 읽어 **도구 호출 자체를 거부**한다.
 */
export interface PolicyConfig {
  /** 정책에 없는 동료의 권한. 생략하면 `read`. */
  readonly default?: string
  /** 지문(§9) → 권한. 지문은 `toHex` 표기 그대로(공백 포함) 붙여 넣어도 된다. */
  readonly peers?: Readonly<Record<string, string>>
}

export interface Config {
  /** 신원 시드 32B (hex). 이것만 있으면 신원 전체가 재파생된다 (§10.2). */
  readonly seed: string
  /**
   * 내 다른 에이전트들의 지문 (§8.1).
   *
   * 여기 적은 서명자의 말만 내 말(`self`)로 친다 — 내 코덱스가 내 클로드에게
   * 시키는 경로가 이것이다. **동료의 지문을 여기 적지 않는다.** 적는 순간
   * 그 사람은 내 기계에 대해 나와 같은 권한을 갖는다.
   *
   * 저장은 정규 표기(공백 없는 소문자 hex)로 한다 — `validate` 가 편다.
   */
  readonly self?: readonly string[]
  /** 동료별 권한 정책 (§8.2). 없으면 전원 `read`. */
  readonly policy?: PolicyConfig
  /** 릴레이 base URL. 없으면 로컬 전용 — 아무것도 주고받지 못한다. */
  readonly relay?: string
  /**
   * 릴레이 쓰기 토큰 (§10.13). 그 릴레이가 요구할 때만 필요하다.
   *
   * 이 파일이 이미 시드와 채널 비밀을 담고 있으므로 토큰이 여기 있는 것이
   * 새로운 노출은 아니다 — 권한 600 검사가 셋 다 함께 지킨다.
   */
  readonly relayToken?: string
  readonly channels: readonly ChannelConfig[]
  /** 로컬 저장소 설정. 없으면 저장소가 자기 기본값으로 선다. */
  readonly store?: StoreConfig
}

/** hex 를 바이트로. 길이가 어긋나면 조용히 자르지 않고 던진다. */
export function fromHex(hex: string, expect?: number): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`hex 가 올바르지 않다: ${hex.slice(0, 16)}…`)
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  if (expect !== undefined && out.length !== expect) {
    throw new Error(`${expect}바이트여야 한다 (받은 값: ${out.length}바이트)`)
  }
  return out
}

/** `~` 를 홈으로 편다. 에이전트 설정에 절대경로를 박게 하지 않기 위함이다. */
export function expandHome(path: string, home = process.env.HOME ?? ''): string {
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
}

export interface LoadOptions {
  /** 파일을 읽는 함수. 테스트에서만 주입한다. */
  readonly read?: (path: string) => Promise<string>
  /** 파일 권한(하위 9비트)을 주는 함수. `undefined` 면 검사를 건너뛴다. */
  readonly mode?: (path: string) => Promise<number | undefined>
}

/**
 * 설정 파일을 읽어 검증한다.
 *
 * 권한이 넓으면 **읽지 않고 던진다.** 시드가 든 파일을 다른 사용자가 읽을
 * 수 있는 상태로 동작시키면, 그 뒤의 모든 암호는 의미가 없다.
 */
export async function loadConfig(path: string, options: LoadOptions = {}): Promise<Config> {
  const file = expandHome(path)
  const read = options.read ?? (async (p: string) => await Bun.file(p).text())
  const mode = options.mode ?? defaultMode

  const found = await mode(file)
  if (found !== undefined && (found & ~MAX_MODE) !== 0) {
    throw new Error(
      `설정 파일 권한이 너무 넓다 — ${file} (권한 ${found.toString(8).padStart(3, '0')}). ` +
        `시드와 채널 비밀이 들어 있으므로 chmod 600 으로 좁혀라.`,
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(await read(file))
  } catch (e) {
    throw new Error(`설정을 읽지 못했다: ${file} (${String(e)})`)
  }
  return validate(raw)
}

async function defaultMode(path: string): Promise<number | undefined> {
  const { stat } = await import('node:fs/promises')
  return (await stat(path)).mode & 0o777
}

/** 형태를 검사한다. 잘못된 설정은 조용히 반쪽 동작하는 것보다 즉시 죽는 편이 낫다. */
export function validate(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null) throw new Error('설정은 객체여야 한다')
  const o = raw as Record<string, unknown>

  if (typeof o.seed !== 'string') throw new Error('seed 가 없다 (32바이트 hex)')
  fromHex(o.seed, 32)

  if (o.relay !== undefined && typeof o.relay !== 'string') throw new Error('relay 는 URL 문자열이다')
  if (o.relayToken !== undefined && typeof o.relayToken !== 'string') {
    throw new Error('relayToken 은 문자열이다 (릴레이 쓰기 토큰)')
  }

  if (!Array.isArray(o.channels)) throw new Error('channels 는 배열이어야 한다')
  const channels = o.channels.map((c, i) => {
    if (typeof c !== 'object' || c === null) throw new Error(`channels[${i}] 가 객체가 아니다`)
    const ch = c as Record<string, unknown>
    if (typeof ch.secret !== 'string') throw new Error(`channels[${i}].secret 이 없다 (32바이트 hex)`)
    fromHex(ch.secret, 32)
    // 축은 선택이지만, 오타는 조용히 넘기지 않는다 — 'internel' 이 통과하면
    // 그 채널은 외부로 떨어지고 사용자는 내부라고 믿는다 (§6.4).
    if (
      ch.axis !== undefined &&
      ch.axis !== 'external' &&
      ch.axis !== 'internal' &&
      ch.axis !== 'local'
    ) {
      throw new Error(`channels[${i}].axis 는 external·internal·local 중 하나다`)
    }
    if (!Array.isArray(ch.members)) throw new Error(`channels[${i}].members 는 배열이어야 한다`)
    ch.members.forEach((m, j) => {
      const mm = m as Record<string, unknown>
      if (typeof mm?.sign !== 'string' || typeof mm?.kem !== 'string') {
        throw new Error(`channels[${i}].members[${j}] 에 sign·kem 이 모두 있어야 한다`)
      }
      fromHex(mm.sign, 32)
      fromHex(mm.kem, 32)
    })
    return ch as unknown as ChannelConfig
  })

  const store = validateStore(o.store)
  const self = validateSelf(o.self)
  const policy = validatePolicy(o.policy)

  return {
    seed: o.seed,
    relay: o.relay as string | undefined,
    relayToken: o.relayToken as string | undefined,
    channels,
    ...(self ? { self } : {}),
    ...(policy ? { policy } : {}),
    ...(store ? { store } : {}),
  }
}

/**
 * 내 에이전트 지문 목록을 검사해 정규 표기로 편다 (§8.1).
 *
 * 오타를 통과시키지 않는다 — 지문 한 글자가 틀리면 그 에이전트는 조용히
 * 동료로 떨어지고, 사용자는 내 코덱스가 왜 막히는지 알 방법이 없다.
 * 반대 방향(동료가 나로 잘못 들어오는 것)은 오타로는 일어나지 않는다.
 */
function validateSelf(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('self 는 지문 hex 문자열의 배열이어야 한다 (§8.1)')
  return raw.map((v, i) => {
    if (typeof v !== 'string') throw new Error(`self[${i}] 가 문자열이 아니다`)
    try {
      return parseKey(v)
    } catch (e) {
      throw new Error(`self[${i}] 가 지문이 아니다: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}

/**
 * 권한 정책을 검사한다 (§8.2).
 *
 * `buildPolicy` 를 태워 **같은 검사**를 쓴다. 여기서 따로 검사하면 설정
 * 로드는 통과하고 노드 조립에서만 죽는 값이 생기고, 그 차이는 훅과 어댑터가
 * 서로 다른 판정을 하는 자리로 돌아온다.
 */
function validatePolicy(raw: unknown): PolicyConfig | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null) throw new Error('policy 는 객체여야 한다')
  const p = raw as Record<string, unknown>
  if (p.default !== undefined && typeof p.default !== 'string') {
    throw new Error(`policy.default 는 ${GRANTS.join('·')} 중 하나다`)
  }
  if (p.peers !== undefined && (typeof p.peers !== 'object' || p.peers === null)) {
    throw new Error('policy.peers 는 지문 → 권한 객체여야 한다')
  }
  const config: PolicyConfig = {
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.peers !== undefined ? { peers: p.peers as Record<string, string> } : {}),
  }
  buildPolicy(config)
  return config
}

/**
 * 저장소 설정을 검사한다 (§6.3).
 *
 * `MessageStore` 생성자도 같은 것을 던지지만, 원인이 설정 파일일 때는 **설정
 * 오류로** 죽는 편이 진단이 된다 — 저장소가 던지면 사용자는 자기가 쓴 값이
 * 아니라 코어를 의심한다.
 */
function validateStore(raw: unknown): StoreConfig | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null) throw new Error('store 는 객체여야 한다')
  const s = raw as Record<string, unknown>

  if (s.dir !== undefined && typeof s.dir !== 'string') throw new Error('store.dir 은 문자열이다')
  // Infinity·0·음수를 전부 막는다. 무제한 보관이 기본값이 아닌 것만으로는
  // 부족하다 — 설정 파일로 넣을 수 있으면 §6.3 은 그 자리로 우회된다.
  if (
    s.retentionMs !== undefined &&
    (typeof s.retentionMs !== 'number' || !Number.isFinite(s.retentionMs) || s.retentionMs <= 0)
  ) {
    throw new Error(
      'store.retentionMs 는 유한한 양수(ms)여야 한다 — 무제한 보관은 허용하지 않는다 (§6.3)',
    )
  }
  if (
    s.maxPerChannel !== undefined &&
    (typeof s.maxPerChannel !== 'number' ||
      !Number.isInteger(s.maxPerChannel) ||
      s.maxPerChannel <= 0)
  ) {
    throw new Error('store.maxPerChannel 은 1 이상의 정수여야 한다')
  }

  return {
    ...(s.dir !== undefined ? { dir: s.dir as string } : {}),
    ...(s.retentionMs !== undefined ? { retentionMs: s.retentionMs as number } : {}),
    ...(s.maxPerChannel !== undefined ? { maxPerChannel: s.maxPerChannel as number } : {}),
  }
}

/**
 * 설정으로 노드를 세운다.
 *
 * 어댑터가 아니라 여기서 조립하는 이유는 §4 그대로다 — 조립 순서를
 * 어댑터마다 다시 쓰면 에이전트에 따라 정책이 갈린다.
 */
export async function buildNode(config: Config): Promise<{ node: MeshNode; identity: Identity }> {
  const identity = await identityOf(config)
  const relay = config.relay
    ? new RelayClient({
        baseUrl: config.relay,
        identity,
        ...(config.relayToken !== undefined ? { relayToken: config.relayToken } : {}),
      })
    : undefined
  const self = new Set(config.self ?? [])
  const node = new MeshNode({
    identity,
    relay,
    selfFingerprints: self,
    policy: buildPolicy(config.policy),
  })

  for (const [i, c] of config.channels.entries()) {
    const channel = new Channel({ secret: fromHex(c.secret, 32), name: c.name })
    for (const m of c.members) {
      const signPublicKey = fromHex(m.sign, 32)
      assertInternalMember(c, i, signPublicKey, m.label, self, identity)
      channel.add({
        signPublicKey,
        kemPublicKey: fromHex(m.kem, 32),
        label: m.label,
      })
    }
    node.join(channel, {
      mentions: c.mentions,
      maxHops: c.maxHops,
      messageBudget: c.messageBudget,
      axis: c.axis,
    })
  }

  return { node, identity }
}

/**
 * 내부 축 채널에 남이 끼어 있지 않은지 본다 (§6.4 · §8.1).
 *
 * `axis: internal|local` 은 "이 채널은 내 다른 세션들뿐"이라는 선언이고, 그
 * 선언에 기대어 §7 홉·예산이 느슨해진다. 그런데 그 채널에 동료가 한 명
 * 들어 있으면 그 사람의 말이 같은 느슨함을 함께 얻는다 — 선언과 실제가
 * 어긋나는데 화면에는 아무 표시도 나지 않는다.
 *
 * 그래서 **로드 시점에 죽인다.** 여기서 통과시키고 도착 시점에 판정하면,
 * 이미 §7 이 헐거워진 뒤라 판정이 늦다.
 *
 * 내 신원은 예외다 — 내 공개키를 멤버로 적는 설정도 유효하다.
 */
function assertInternalMember(
  c: ChannelConfig,
  index: number,
  signPublicKey: Uint8Array,
  label: string | undefined,
  self: ReadonlySet<string>,
  identity: Identity,
): void {
  if (c.axis === undefined || c.axis === 'external') return

  const fp = fingerprint(signPublicKey)
  const key = toKey(fp)
  if (key === toKey(identity.fingerprint)) return
  if (self.has(key)) return

  throw new Error(
    `channels[${index}] 는 axis: ${c.axis} 인데 내 것이 아닌 멤버가 있다` +
      `${label !== undefined ? ` (${label})` : ''} — 지문 ${toHex(fp)}. ` +
      `내 다른 에이전트라면 그 지문을 self 에 적고, 동료라면 이 채널의 axis 를 external 로 둔다 (§8.1).`,
  )
}
