/**
 * 릴레이 실행 인자와 기동 — 진입점은 `src/server.ts` 다
 *
 * 설계 근거는 docs/architecture.md §10.7.
 *
 * `createHandler` 는 표준 `Request`/`Response` 만 쓰므로 여기서 하는 일은
 * `Bun.serve()` 에 넘기는 것뿐이다. 서버리스 배포도 같은 핸들러를 쓴다 —
 * 라우팅이나 검증을 여기서 다시 만들면 두 경로의 동작이 갈린다.
 *
 * `start()` 의 **저장소가 메모리다.** 프로세스가 죽으면 대기 중인 봉투가
 * 사라진다. 로컬 개발과 신뢰하는 소규모 자체 호스팅까지가 그 범위이며,
 * 서버리스에 올릴 때는 인스턴스마다 메모리가 갈리므로 반드시 외부
 * 저장소를 쓴다(`MemoryStore` 주석 · §10.7). 진입점이 그 선택을 한다.
 */
import { createHandler } from './http.js'
import { MemoryStore, DEFAULT_TTL_MS, DEFAULT_MAX_QUEUE } from './store.js'
import { MIN_TOKEN_CHARS, type PostAuth } from './post-auth.js'

/** 기본 포트. 흔한 개발 포트와 겹치지 않는 값을 고른다. */
export const DEFAULT_PORT = 8787

/** 값이 어디서 왔는지. 기동 실패 메시지에서 사용자가 어디를 고칠지 정한다. */
export type Origin = 'flag' | 'env' | 'default'

export interface ServeArgs {
  readonly port: number
  /** 묶을 주소. 기본은 로컬 전용이다 — §10.12 때문에 기본 공개하지 않는다. */
  readonly host: string
  readonly ttlMs: number
  readonly maxQueue: number
  /**
   * 바인딩 인자의 출처. `parseArgs` 만 이걸 알 수 있다 — 같은 `'0.0.0.0'`
   * 이라도 사람이 타이핑한 것과 셸이 흘려보낸 것은 고칠 곳이 다르다.
   * 직접 조립한 `ServeArgs` 에는 없어도 된다(전부 기본값으로 본다).
   */
  readonly origin?: { readonly host: Origin; readonly port: Origin }
}

const USAGE = `agent-channel-mesh 릴레이

  bun run src/server.ts --port ${DEFAULT_PORT}

  --port <n>       기본 ${DEFAULT_PORT} (0 이면 OS 가 빈 포트를 고른다)
  --host <addr>    기본 127.0.0.1 (외부 공개는 0.0.0.0)
  --ttl <ms>       봉투 보관 기간, 기본 ${DEFAULT_TTL_MS} (7일)
  --max-queue <n>  수신자당 큐 상한, 기본 ${DEFAULT_MAX_QUEUE}

  ACM_RELAY_TOKEN  쓰기 토큰 (환경변수, 최소 ${MIN_TOKEN_CHARS}자 — \`openssl rand -hex 32\`).
                   루프백 밖으로 열려면 반드시 있어야 한다 (§10.13).
                   플래그가 아닌 이유는 \`ps\` 에 그대로 찍히기 때문이다.

  POST /post            봉투를 올린다
  GET  /fetch/<key id>  수신함을 비우며 가져간다
  GET  /health          상태 확인
`

/**
 * 인자를 읽는다. 모르는 인자는 던진다 — 오타가 조용히 기본값이 되면 안 된다.
 *
 * **잘못된 값의 처리가 출처에 따라 다르다.** 플래그는 이번 호출에 사람이
 * 직접 타이핑한 것이라 조용히 기본값으로 바꾸면 오타가 그대로 다른 포트가
 * 된다 — 던진다. 환경변수는 플랫폼·셸 프로파일·부모 프로세스에서 흘러들어올
 * 수 있는 주변 값이라, 그런 값 때문에 서버를 죽이지 않는다 — 기본값으로
 * 되돌린다. 같은 값이라도 출처가 다르면 실패 방식이 달라야 한다.
 */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): ServeArgs {
  const fromEnv = { port: parsePort(env.PORT), host: parseHost(env.HOST) }
  let port = fromEnv.port ?? DEFAULT_PORT
  // 기본을 루프백으로 둔다. 조회는 인증되지만(§10.12) 메타데이터는 그대로
  // 드러나고 봉투 전송은 누구나 할 수 있으므로, 공개는 명시적이어야 한다.
  let host = fromEnv.host ?? '127.0.0.1'
  let ttlMs = parsePositive(env.ACM_TTL_MS) ?? DEFAULT_TTL_MS
  let maxQueue = parsePositive(env.ACM_MAX_QUEUE) ?? DEFAULT_MAX_QUEUE
  const origin = {
    port: fromEnv.port === undefined ? ('default' as Origin) : ('env' as Origin),
    host: fromEnv.host === undefined ? ('default' as Origin) : ('env' as Origin),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--port') {
      port = required(argv[++i], '--port', parsePort)
      origin.port = 'flag'
    } else if (arg === '--host') {
      host = required(argv[++i], '--host', parseHost)
      origin.host = 'flag'
    } else if (arg === '--ttl') ttlMs = required(argv[++i], '--ttl', parsePositive)
    else if (arg === '--max-queue') maxQueue = required(argv[++i], '--max-queue', parsePositive)
    else throw new Error(`모르는 인자: ${arg}\n\n${USAGE}`)
  }
  return { port, host, ttlMs, maxQueue, origin }
}

/**
 * 포트 도메인 — 정수 0..65535.
 *
 * **0 은 유효하다.** POSIX 에서 0 은 "OS 가 빈 포트를 고른다"는 뜻이고,
 * `start()` 가 실제로 그 값을 돌려주도록 만들어져 있다. 검증기 하나를 네
 * 플래그가 나눠 쓰면서 이 도메인이 `n > 0` 으로 잘못 좁혀져 있었다.
 *
 * 상한과 정수 검사가 여기 있는 이유는, 없으면 `--port 99999` 나 `--port 1.5`
 * 가 파서를 통과해 `Bun.serve()` 안쪽에서 알아보기 힘든 에러로 터지기
 * 때문이다. `bindError` 가 그 실패에 우리가 넘긴 값을 붙여 주긴 하지만,
 * 그건 "무엇을 넘겼는지"까지다 — **어느 인자가 왜 틀렸는지**는 도메인을
 * 아는 여기서만 말할 수 있다. 판정할 수 있는 것은 판정해서 바인딩까지
 * 가지 않게 한다.
 *
 * 숫자 문자열만 받는다. `Number('')` 와 `Number(' ')` 가 0 이라, 그대로
 * 넘기면 빈 값이 ephemeral 포트로 둔갑한다.
 */
function parsePort(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text)) return undefined
  const n = Number(text)
  return n <= 65535 ? n : undefined
}

/**
 * 호스트 도메인 — 값이 있어야 하고 `-` 로 시작하면 안 된다.
 *
 * 이 둘만 본다. 진짜 호스트명·IP 인지는 검사하지 않는다 — 바인딩할 수 없는
 * 주소는 `Bun.serve()` 가 스스로 거부하고, 여기서 절반만 맞는 정규식을 쓰면
 * 유효한 값(IPv6 리터럴, 호스트명, `::`)을 막게 된다.
 *
 * 여기서 잡는 건 파싱 불가능한 주소가 아니라 **빠진 값**과 **삼켜진
 * 플래그**다. `--host` 뒤에 값이 없으면 조용히 기본값이 되고,
 * `--host --port 9000` 은 `"--port"` 를 호스트로 삼킨다 — 둘 다 사용자가
 * 요청하지 않은 곳에 릴레이가 조용히 묶이는 길이고, 조회 인증(§10.12)이
 * 메타데이터까지 가려 주지는 않으므로 그 조용함이 그대로 노출이 된다.
 */
function parseHost(text: string | undefined): string | undefined {
  // 공백뿐인 값은 빈 값이 변장한 것이다 — 셸이 넘긴 공백을 "값을 줬다"로 치면
  // `--host ' '` 가 파서를 통과해 바인딩 단계에서 엉뚱한 메시지로 터진다.
  // 호스트명의 생김새를 주장하는 게 아니라, "값이 없다"의 범위를 넓히는 것이다.
  if (text === undefined || text.trim() === '' || text.startsWith('-')) return undefined
  return text
}

/** 양수 도메인 — 보관 기간과 큐 상한. 0 이나 음수는 의미가 없다. */
function parsePositive(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * `Bun.serve()` 기동 실패를 우리가 넘긴 값과 그 출처로 감싼다.
 *
 * Bun 은 바인딩이 실패하면 원인과 무관하게 `Failed to start server. Is port
 * <n> in use?` 를 던진다. 호스트가 문제여도 포트를 지목하고, `--port 0` 처럼
 * 이 프로젝트가 유효하다고 문서화한 값을 범인으로 부른다 — 사용자가 그 말을
 * 믿으면 멀쩡한 인자를 고치게 된다.
 *
 * 그렇다고 파서가 대신 잡을 수도 없다. 호스트가 바인딩 가능한지는 형식
 * 검사로 결정되지 않고(`not!a!hostname` 도 `999.999.999.999` 도 정규식으로
 * 가려낼 수 없다), 절반만 맞는 검사를 쓰면 유효한 값을 막는다. 그래서
 * **둘 중 누가 틀렸는지 추측하지 않고, 우리가 넘긴 것을 그대로 보여준다.**
 * 원문은 지운다고 나아지지 않으므로 그대로 남긴다.
 *
 * 포트가 정말 사용 중인 경우도 이 형식이 더 낫다 — 사용자가 자기가 준 포트를
 * 눈으로 확인하게 된다.
 */
export function bindError(cause: unknown, args: ServeArgs): Error {
  const origin = args.origin ?? { host: 'default', port: 'default' }
  const label: Record<Origin, string> = { flag: '플래그', env: '환경변수', default: '기본값' }
  // 호스트를 따옴표로 감싼다 — 공백뿐인 값이 눈에 보여야 한다.
  const host = `--host '${args.host}'`.padEnd(23)
  const port = `--port ${args.port}`.padEnd(23)
  return new Error(
    `릴레이를 띄우지 못했다: ${cause instanceof Error ? cause.message : String(cause)}\n` +
      `  ${host} (${label[origin.host]})\n` +
      `  ${port} (${label[origin.port]})`,
    { cause },
  )
}

function required<T>(raw: string | undefined, flag: string, parse: (t: string | undefined) => T | undefined): T {
  const value = parse(raw)
  // 값을 따옴표로 감싼다 — 따옴표가 없으면 `--host ' '` 의 거절 사유가
  // 빈칸으로 찍혀서, 무엇이 거부됐는지 보이지 않는다.
  if (value === undefined) throw new Error(`${flag} 값이 잘못됐다: ${raw === undefined ? '없음' : `'${raw}'`}\n\n${USAGE}`)
  return value
}

/**
 * 릴레이를 띄운다.
 *
 * 돌려주는 것에 실제 포트가 들어 있다 — `--port 0` 으로 띄우면 OS 가
 * 고르므로, 테스트가 그 값을 알아야 접속할 수 있다.
 *
 * 쓰기 정책을 인자로 받는다. 여기서 환경변수를 읽어 스스로 정하면 같은
 * 판단이 진입점(`src/server.ts`)과 두 군데에 생기고, 두 경로의 보안이 갈리는
 * 순간은 배포한 뒤에야 드러난다. 판단은 `selectPostAuth` 한 곳이 갖는다.
 */
export function start(
  args: ServeArgs,
  postAuth: PostAuth,
): { port: number; stop: () => void; url: string } {
  const handler = createHandler({
    store: new MemoryStore({ ttlMs: args.ttlMs, maxQueue: args.maxQueue }),
    postAuth,
  })
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({ port: args.port, hostname: args.host, fetch: handler })
  } catch (e) {
    throw bindError(e, args)
  }
  // TCP 로 띄웠으므로 포트가 반드시 있다 — 없는 경우는 유닉스 소켓뿐이다.
  const port = server.port
  if (port === undefined) throw new Error('포트를 얻지 못했다')
  return {
    port,
    url: `http://${args.host}:${port}`,
    stop: () => void server.stop(),
  }
}
