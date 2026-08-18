/**
 * 권한 — 도착한 말이 내 기계에서 무엇까지 할 수 있는가
 *
 * 설계 근거는 docs/architecture.md §8「권한」.
 *
 * 채널 멤버는 서로 동료다. 위아래가 없고, 도착한 말은 지시가 아니라
 * **공유**다. 그래서 이 파일이 나누는 것은 사람의 지위가 아니라 **내 기계에
 * 대한 권한**이다 — 동료가 내 저장소를 읽고 답을 받는 것은 자연스럽고,
 * 동료의 말 때문에 내 디스크가 바뀌거나 명령이 도는 것은 자연스럽지 않다.
 *
 * 판정 근거는 채널 라벨이 아니라 **검증된 서명자**다. 축(`axis`)은 내가 내
 * 설정에 적은 분류값이라 사람 손이 틀릴 수 있지만, 서명자는 Ed25519 검증을
 * 통과한 값이라 위조되지 않는다. 그래서 `self` 판정은 메시지 단위다.
 */
import { parseKey } from '../identity/fingerprint.js'

/**
 * 이 메시지가 나냐 동료냐.
 *
 * `self` 는 "내가 내 다른 에이전트에서 보냈다"는 뜻이다 — 내 코덱스가 내
 * 클로드에게 시키는 경로가 이것이고, 그건 내가 나에게 시키는 것이라 막을
 * 이유가 없다. 그 외 전부가 `peer` 다.
 */
export type Authority = 'self' | 'peer'

/**
 * 권한 사다리. `read < write < execute` 로 단조 증가한다.
 *
 * `full` 을 두지 않는다 — 어떤 키를 `self` 에 넣는 것이 이미 "사실상 나"라는
 * 선언이므로, 그 위에 등급을 하나 더 두면 같은 뜻의 표현이 둘이 된다.
 */
export type Grant = 'read' | 'write' | 'execute'

/** 낮은 것부터. 설정 검증과 오류 문구가 같은 목록을 쓴다. */
export const GRANTS: readonly Grant[] = ['read', 'write', 'execute']

/**
 * 정책에 안 적힌 동료의 기본 권한.
 *
 * 읽기다 — 동료의 말은 공유이지 내 기계에 대한 권한이 아니다. 올리는 것은
 * 내가 설정 파일에 지문을 적어 명시할 때만 일어난다.
 */
export const DEFAULT_PEER_GRANT: Grant = 'read'

export function isGrant(v: unknown): v is Grant {
  return typeof v === 'string' && (GRANTS as readonly string[]).includes(v)
}

export function rank(g: Grant): number {
  return GRANTS.indexOf(g)
}

/** 가진 권한이 필요한 권한을 덮는가. */
export function allows(held: Grant, need: Grant): boolean {
  return rank(held) >= rank(need)
}

/** 둘 중 낮은 쪽. 오염이 겹칠 때 쓴다 — 겹치면 더 좁아져야 한다. */
export function lower(a: Grant, b: Grant): Grant {
  return rank(a) <= rank(b) ? a : b
}

/**
 * 발신자별 권한 정책 (§8.2).
 *
 * 키는 지문의 정규 표기(`fingerprint.toKey`)다. 프롬프트 파일이 아니라
 * 600 설정 파일에 두는 이유는, 프롬프트 룰은 압축되면 사라지는데(§6.1)
 * 권한은 사라지면 안 되기 때문이다.
 */
export interface Policy {
  /** 정책에 없는 동료의 권한. 기본은 `read`. */
  readonly fallback: Grant
  /** 지문 → 권한. 여기 적힌 사람만 기본값을 벗어난다. */
  readonly peers: ReadonlyMap<string, Grant>
}

export const OPEN_POLICY: Policy = { fallback: DEFAULT_PEER_GRANT, peers: new Map() }

/**
 * 이 메시지가 내 기계에서 갖는 권한.
 *
 * `self` 는 사다리 꼭대기다 — 내 다른 에이전트는 나이므로 제한할 근거가
 * 없다. 지문을 모르면(멤버 목록에 없는 발신자) 기본값으로 떨어진다.
 */
export function grantOf(policy: Policy, authority: Authority, fingerprint?: string): Grant {
  if (authority === 'self') return 'execute'
  if (fingerprint === undefined) return policy.fallback
  return policy.peers.get(fingerprint) ?? policy.fallback
}

/**
 * 설정에서 읽은 정책을 검증해 세운다.
 *
 * 지문 표기는 `toHex` 가 4자씩 띄운 형태로 나오므로 공백을 받아 준다.
 * 등급이 어긋나면 던진다 — 오타 하나가 조용히 기본값으로 떨어지면,
 * 정책을 적은 사람은 걸려 있다고 믿는데 실제로는 안 걸린 상태가 된다.
 */
export function buildPolicy(input?: {
  readonly default?: string
  readonly peers?: Readonly<Record<string, string>>
}): Policy {
  const fallback = input?.default
  if (fallback !== undefined && !isGrant(fallback)) {
    throw new Error(`policy.default 는 ${GRANTS.join('·')} 중 하나다 (받은 값: ${fallback})`)
  }
  const peers = new Map<string, Grant>()
  for (const [fp, grant] of Object.entries(input?.peers ?? {})) {
    if (!isGrant(grant)) {
      throw new Error(`policy.peers['${fp}'] 는 ${GRANTS.join('·')} 중 하나다 (받은 값: ${grant})`)
    }
    peers.set(parseKey(fp), grant)
  }
  return { fallback: fallback ?? DEFAULT_PEER_GRANT, peers }
}

/**
 * 저장된 한 건에서 권한을 읽을 때 필요한 최소 형태.
 *
 * `StoredMessage` 를 직접 받지 않는다 — 정책이 저장소를 import 하면 의존이
 * 서로를 향하고, 저장소가 이미 정책을 import 하고 있다.
 */
export interface AuthorityRecord {
  readonly direction: 'in' | 'out'
  readonly authority?: Authority
  readonly grant?: Grant
}

/**
 * 이 기록의 권한 주체. 없으면 동료로 읽는다.
 *
 * 버전 1·2 저장 파일에는 이 필드가 없다. 없는 것을 나로 읽으면 옛 파일의
 * 동료 메시지가 조용히 내 권한을 얻는다 — 그래서 없을 때의 답은 `peer` 다.
 * 내가 보낸 것(`out`)은 필드가 없어도 나다.
 */
export function recordAuthority(m: AuthorityRecord): Authority {
  return m.direction === 'out' ? 'self' : (m.authority ?? 'peer')
}

/** 이 기록이 갖는 권한. 없으면 동료 기본값(`read`). */
export function recordGrant(m: AuthorityRecord): Grant {
  if (m.direction === 'out') return 'execute'
  return m.grant ?? (recordAuthority(m) === 'self' ? 'execute' : DEFAULT_PEER_GRANT)
}

/**
 * 우리 MCP 서버 이름 (`src/install/plugin.ts` 의 `PACKAGE_NAME`).
 *
 * 여기에 문자열로 다시 적는 이유는 훅이 설치 코드를 끌고 들어오지 않게
 * 하기 위해서다 — 훅은 툴 호출마다 도는 경로라 가벼워야 한다.
 * 어긋나면 우리 툴이 `execute` 로 떨어져 **막히는** 쪽이므로 안전한 방향이다.
 */
const MESH_SERVER = 'agent-channel-mesh'

/**
 * 메시 자신의 툴 — 읽기 권한에서도 쓸 수 있다.
 *
 * `send` 가 여기 있는 것은 의도다. 동료가 말을 걸었는데 답을 못 하면 메시가
 * 대화 도구이기를 그만두고, 그 채널의 총량은 이미 §7 발화 예산이 잡고 있다.
 * `setup` 은 없다 — 신원을 만드는 일이라 읽기가 아니다.
 */
const MESH_TOOLS = new Set(['send', 'inbox', 'channels', 'whoami'])

/**
 * 읽기로 분류하는 내장 툴.
 *
 * 앞쪽이 Claude Code, 뒤쪽이 Codex 다. **모르는 이름은 여기 없다** — 분류에
 * 없으면 `execute` 로 떨어지고, 그것이 이 표의 설계다(fail-closed).
 */
const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
  'read_file',
  'list_dir',
  'grep',
  'view_image',
  'update_plan',
])

/** 쓰기로 분류하는 내장 툴. 디스크는 바꾸지만 명령을 돌리지는 않는다. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

/**
 * 이 툴을 부르려면 어느 권한이 필요한가.
 *
 * 모르는 이름은 전부 `execute` 다. 네트워크로 나가는 툴(`WebFetch`·
 * `WebSearch`)도 여기로 떨어진다 — 동료의 말로 임의의 주소에 요청이 나가면
 * 그 자체가 유출 통로라서, 읽기로 분류할 수 없다.
 *
 * 남의 MCP 툴은 이름만으로는 무엇을 하는지 알 수 없으므로 전부 `execute` 다.
 * 우리 서버의 툴만 이름으로 분류한다.
 */
export function toolGrant(name: string): Grant {
  const tool = name.trim()
  if (tool === '') return 'execute'

  if (tool.startsWith('mcp__')) {
    const rest = tool.slice('mcp__'.length)
    const cut = rest.indexOf('__')
    if (cut < 0) return 'execute'
    // 서버 구간은 설치 형태에 따라 `plugin_<이름>_<이름>` 처럼 붙는다.
    // 정확히 일치를 요구하면 설치 경로마다 갈리므로 포함으로 본다.
    if (!rest.slice(0, cut).includes(MESH_SERVER)) return 'execute'
    return MESH_TOOLS.has(rest.slice(cut + 2)) ? 'read' : 'execute'
  }

  if (READ_TOOLS.has(tool)) return 'read'
  if (WRITE_TOOLS.has(tool)) return 'write'
  return 'execute'
}
