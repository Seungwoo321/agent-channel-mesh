/**
 * 채널 파일 자문 잠금 — 프로세스 사이의 read-modify-write 를 직렬화한다
 *
 * 설계 근거는 docs/architecture.md §6.3「로컬 저장소는 코어가 소유한다」·
 * §6.6「도착을 세션이 알게 하는 세 경로」.
 *
 * 저장소를 만지는 것은 한 프로세스가 아니다 — 어댑터(MCP 서버)와 훅은 **별개
 * 프로세스**이고 둘 다 같은 파일을 읽고 고쳐 쓴다. `write()` 가 temp+rename 이라
 * 파일이 찢어지지는 않지만, 그건 **한 번의 쓰기**만 원자적이라는 뜻이다. 읽고
 * 고쳐 쓰는 구간 전체는 보호되지 않으므로 나중 쓰기가 앞선 쓰기를 통째로 덮는다
 * (lost update). 정본이라고 선언한 곳에서 도착한 메시지가 흔적 없이 사라진다.
 *
 * 그래서 **채널 파일마다 잠금 파일 하나**를 둔다. 채널당 파일 하나라는 저장 형상
 * (§6.3)이 그대로 잠금 단위가 되므로, 다른 채널끼리는 서로를 기다리지 않는다.
 *
 * 획득은 `open(path, 'wx')` — POSIX `O_CREAT|O_EXCL` 이라 **커널이 원자적으로**
 * 판정한다. `existsSync` 로 보고 `writeFile` 하는 검사-후-실행은 두 프로세스가
 * 같은 틈에 들어와 둘 다 통과하므로, 막으려던 경합을 그대로 남긴다.
 */
import { open, readFile, stat, unlink } from 'node:fs/promises'

/** 잠금 파일 이름은 채널 파일 뒤에 붙는다. `<채널>.json.lock`. */
export const LOCK_SUFFIX = '.lock'

/**
 * 이 시간을 넘긴 잠금은 뺏는다.
 *
 * 실제 임계 구역은 파일 하나를 읽고 쓰는 ms 단위 작업이다. 10초는 그보다 세
 * 자릿수 넉넉하므로, 살아 있는 홀더를 뺏을 일은 사실상 없다. 그럼에도 회수가
 * 있어야 하는 이유는 **프로세스가 죽으면 잠금 파일이 남기 때문**이다 — 자문
 * 잠금은 커널이 정리해 주지 않는다. 회수가 없으면 어댑터가 한 번 죽는 것으로
 * 그 채널의 메시가 영구히 멈춘다.
 */
export const STALE_LOCK_MS = 10_000

/** 잠금을 못 잡은 채 이만큼 지나면 포기하고 던진다. 무한 대기는 교착과 같다. */
export const LOCK_TIMEOUT_MS = 5_000

/** 첫 재시도 간격. 임계 구역이 ms 단위라 짧게 시작한다. */
const FIRST_BACKOFF_MS = 5

/** 재시도 간격 상한. 지수 증가가 여기서 멈춘다. */
const MAX_BACKOFF_MS = 50

/** 잠금 파일 권한. 채널 파일(0600)과 같은 기준이다 — pid 도 정보다. */
const LOCK_MODE = 0o600

export interface LockOptions {
  /** 이 나이를 넘긴 잠금을 stale 로 본다. 기본 {@link STALE_LOCK_MS}. */
  readonly staleMs?: number
  /** 획득 총 대기 상한. 기본 {@link LOCK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** 경고 출력. 기본 stderr — 잠금을 뺏는 것은 조용히 지나갈 일이 아니다. */
  readonly warn?: (message: string) => void
  /**
   * 디렉토리를 확보한다. 잠금 파일도 그 디렉토리에 생기므로, 첫 쓰기처럼
   * 디렉토리가 아직 없을 수 있는 경로는 이걸 준다. 주지 않으면 ENOENT 가
   * 그대로 올라간다 — purge 처럼 "없으면 지울 것도 없다"인 경로가 그걸 쓴다.
   */
  readonly ensureDir?: () => Promise<void>
}

/** 잠금 파일에 남기는 것. 진단(누가 들고 있나)과 stale 판정(언제부터)에 쓴다. */
interface LockHolder {
  readonly pid: number
  readonly acquiredAt: number
  /** 이 잠금이 **내 것**이라는 표시. 해제 때 대조한다. */
  readonly token: string
}

/** 이 채널 파일의 잠금 파일 자리. 진단과 테스트가 직접 확인할 때 쓴다. */
export function lockPathOf(file: string): string {
  return `${file}${LOCK_SUFFIX}`
}

/**
 * 잠금을 잡고 `fn` 을 돌린다. 끝나면 **반드시** 놓는다.
 *
 * `fn` 이 던져도 `finally` 에서 놓는다 — 예외 하나로 채널이 멈추면 회수 시간
 * (10초)만큼 메시가 서고, 그건 잠금이 막으려던 것보다 눈에 띄는 고장이다.
 *
 * **두 채널의 잠금을 동시에 들지 않는다.** 여러 채널을 도는 호출자는 하나씩
 * 잡았다 놓는다 — 두 프로세스가 서로 반대 순서로 잡으면 그 자리가 교착이다.
 */
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const path = lockPathOf(file)
  const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  if (options.ensureDir !== undefined) await options.ensureDir()

  const token = await acquire(path, {
    staleMs: options.staleMs ?? STALE_LOCK_MS,
    timeoutMs: options.timeoutMs ?? LOCK_TIMEOUT_MS,
    warn,
  })
  try {
    return await fn()
  } finally {
    await release(path, token, warn)
  }
}

interface Resolved {
  readonly staleMs: number
  readonly timeoutMs: number
  readonly warn: (message: string) => void
}

async function acquire(path: string, o: Resolved): Promise<string> {
  const deadline = Date.now() + o.timeoutMs
  let backoff = FIRST_BACKOFF_MS

  for (;;) {
    const token = randomToken()
    try {
      // 'wx' = O_CREAT|O_EXCL. 이미 있으면 EEXIST 로 실패한다 — 판정이 커널에
      // 있으므로 두 프로세스가 동시에 들어와도 하나만 성공한다.
      const fh = await open(path, 'wx', LOCK_MODE)
      try {
        const holder: LockHolder = { pid: process.pid, acquiredAt: Date.now(), token }
        await fh.writeFile(JSON.stringify(holder))
        // open 의 mode 는 umask 로 좁아질 뿐 넓어지지 않지만, 확정해 두면
        // 어느 경로로 와도 0600 이다. 채널 파일 쓰기와 같은 이유다.
        await fh.chmod(LOCK_MODE)
      } finally {
        await fh.close()
      }
      return token
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }

    const age = await lockAge(path)
    if (age === undefined) continue // 그 사이 홀더가 놓았다 — 바로 다시 잡는다
    if (age >= o.staleMs) {
      // 조용히 뺏지 않는다. 홀더가 죽었다는 뜻이고, 그건 알아야 할 사실이다.
      o.warn(
        `[agent-channel-mesh] 오래된 잠금을 회수한다: ${path} ` +
          `(${Math.round(age)}ms 경과, 기준 ${o.staleMs}ms). 잠금을 들고 있던 프로세스가 죽은 것으로 본다.`,
      )
      await unlinkQuiet(path)
      // 뺏은 뒤에도 획득은 'wx' 로 겨룬다 — 둘이 같이 뺏어도 하나만 성공한다.
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `저장소 잠금을 ${o.timeoutMs}ms 안에 잡지 못했다: ${path}. ` +
          `다른 프로세스가 같은 채널을 오래 붙들고 있다.`,
      )
    }
    // 지터를 섞는다. 같은 간격으로 깨면 두 프로세스가 계속 같은 순간에 겹쳐
    // 한쪽이 오래 굶는다 — 재시도 간격을 흩는 것은 백오프의 표준 짝이다.
    await sleep(backoff / 2 + Math.random() * (backoff / 2))
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

/**
 * 잠금을 놓는다. **내 것일 때만** 지운다.
 *
 * 회수(stale)가 있는 이상 내 잠금이 남에게 넘어갔을 수 있다. 그때 무조건
 * `unlink` 하면 지금 정당하게 들고 있는 쪽의 잠금을 지우게 되고, 그러면 회수
 * 장치가 오히려 경합을 만든다. 대조 후 지우는 것이 완전히 원자적이지는 않지만,
 * 그 창은 회수가 이미 일어난 뒤(10초 초과)로 좁다.
 */
async function release(path: string, token: string, warn: (m: string) => void): Promise<void> {
  const holder = await readHolder(path)
  if (holder === undefined) return // 이미 회수돼 사라졌다
  if (holder.token !== token) {
    warn(
      `[agent-channel-mesh] 내 잠금이 회수된 뒤였다: ${path} ` +
        `(지금 홀더 pid ${String(holder.pid)}). 이 구간의 쓰기가 겹쳤을 수 있다.`,
    )
    return
  }
  await unlinkQuiet(path)
}

/** 잠금 파일의 나이(ms). 없으면 `undefined`. */
async function lockAge(path: string): Promise<number | undefined> {
  const holder = await readHolder(path)
  if (holder !== undefined) return Date.now() - holder.acquiredAt
  // 내용이 깨졌거나 아직 안 쓰인 잠금 — 파일 시각으로 판정한다. 여기서
  // 포기하면 반쪽짜리 잠금 파일 하나가 채널을 영구히 막는다.
  try {
    return Date.now() - (await stat(path)).mtimeMs
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const o = parsed as Record<string, unknown>
    if (typeof o.acquiredAt !== 'number' || typeof o.token !== 'string') return undefined
    return { pid: typeof o.pid === 'number' ? o.pid : -1, acquiredAt: o.acquiredAt, token: o.token }
  } catch {
    // 쓰는 도중이라 반쪽인 경우다. 나이는 파일 시각으로 판정한다.
    return undefined
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (e) {
    if (!isMissing(e)) throw e
  }
}

function randomToken(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
