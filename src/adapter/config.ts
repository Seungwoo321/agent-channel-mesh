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
}

export interface Config {
  /** 신원 시드 32B (hex). 이것만 있으면 신원 전체가 재파생된다 (§10.2). */
  readonly seed: string
  /** 릴레이 base URL. 없으면 로컬 전용 — 아무것도 주고받지 못한다. */
  readonly relay?: string
  readonly channels: readonly ChannelConfig[]
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

  if (!Array.isArray(o.channels)) throw new Error('channels 는 배열이어야 한다')
  const channels = o.channels.map((c, i) => {
    if (typeof c !== 'object' || c === null) throw new Error(`channels[${i}] 가 객체가 아니다`)
    const ch = c as Record<string, unknown>
    if (typeof ch.secret !== 'string') throw new Error(`channels[${i}].secret 이 없다 (32바이트 hex)`)
    fromHex(ch.secret, 32)
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

  return { seed: o.seed, relay: o.relay as string | undefined, channels }
}

/**
 * 설정으로 노드를 세운다.
 *
 * 어댑터가 아니라 여기서 조립하는 이유는 §4 그대로다 — 조립 순서를
 * 어댑터마다 다시 쓰면 에이전트에 따라 정책이 갈린다.
 */
export async function buildNode(config: Config): Promise<{ node: MeshNode; identity: Identity }> {
  const identity = await deriveIdentity(fromHex(config.seed, 32))
  const relay = config.relay
    ? new RelayClient({ baseUrl: config.relay, identity })
    : undefined
  const node = new MeshNode({ identity, relay })

  for (const c of config.channels) {
    const channel = new Channel({ secret: fromHex(c.secret, 32), name: c.name })
    for (const m of c.members) {
      channel.add({
        signPublicKey: fromHex(m.sign, 32),
        kemPublicKey: fromHex(m.kem, 32),
        label: m.label,
      })
    }
    node.join(channel, {
      mentions: c.mentions,
      maxHops: c.maxHops,
      messageBudget: c.messageBudget,
    })
  }

  return { node, identity }
}
