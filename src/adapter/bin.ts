#!/usr/bin/env bun
/**
 * 어댑터 실행 진입점 — 에이전트가 서브프로세스로 띄우는 그 프로세스
 *
 * 설계 근거는 docs/architecture.md §4「어댑터」.
 *
 *   bun run src/adapter/bin.ts --delivery inbox
 *
 * 전달 방식은 **명시로만 정한다.** 환경을 보고 추측하면 틀렸을 때
 * 조용히 틀린다 — Claude 에서 수신함 모드로 뜨면 메시지가 도착해도
 * 세션은 영원히 모르고, Codex 에서 주입 모드로 뜨면 선언한 capability 를
 * 아무도 구현하지 않는다. 둘 다 "동작하는 것처럼 보이는 고장"이다.
 *
 * stdout 은 MCP 프레이밍이 쓴다. 사람에게 하는 말은 전부 stderr 로 나간다.
 */
import { loadConfig, buildNode, storeOptionsOf, expandHome, DEFAULT_CONFIG_PATH } from './config.js'
import { serve, type Delivery } from './server.js'
import { serveSetup } from './setup.js'
import { MessageStore } from '../store/store.js'
import { init, whoami, newChannelSecret } from './onboard.js'
import { format } from '../identity/fingerprint.js'
import { hookMain } from '../install/notify.js'

/** 무엇을 하러 왔는가. `serve` 만 전달 방식을 요구한다. */
export type Command = 'serve' | 'init' | 'whoami' | 'hook'

export interface Args {
  readonly command: Command
  /** `serve` 일 때만 의미가 있다. */
  readonly delivery?: Delivery
  readonly config: string
  /** `init` 에서 설정에 박아 둘 릴레이 URL. */
  readonly relay?: string
  /**
   * `init` 에서 설정에 박아 둘 릴레이 쓰기 토큰 (§10.13).
   *
   * 환경변수(`ACM_RELAY_TOKEN`)로만 받는다 — 플래그로 주면 `ps` 에 찍혀
   * 같은 기계의 다른 사용자가 프로세스 목록만으로 가져간다.
   */
  readonly relayToken?: string
  /** `init`·`whoami` 에서 쓸 이름. 신뢰의 근거가 아니다 — 근거는 지문뿐이다(§9). */
  readonly label?: string
  /** `hook` 이 그대로 넘길 인자. 훅 런타임이 `--event` 를 읽는다. */
  readonly rest?: readonly string[]
}

const USAGE = `agent-channel-mesh

  init                         설정을 만든다 (시드 생성 + 0600)
  whoami                       상대에게 보낼 공개키와 내 지문을 보여준다
  hook --event <이름>          훅 런타임. 에이전트가 부른다 (직접 부를 일은 없다)
  --delivery <push|inbox|both> 어댑터를 띄운다

  --config <path>   기본값 ${DEFAULT_CONFIG_PATH} (환경변수 ACM_CONFIG 로도 지정)
  --relay <url>     init 이 설정에 박아 둘 릴레이 URL
  --label <name>    내 이름 (기본값: 내이름)

  ACM_RELAY_TOKEN   릴레이 쓰기 토큰 (환경변수). init 이 설정에 옮겨 적는다.
                    플래그가 아닌 이유는 \`ps\` 에 그대로 찍히기 때문이다.

  --delivery push    Claude Code — 세션에 능동 주입한다
  --delivery inbox   그 외 에이전트(Codex 등) — 수신함에 쌓고 inbox 툴로 꺼낸다
  --delivery both    주입 + 수신함. Claude Code 에서 기본으로 쓸 형태다 —
                     주입은 개발 플래그(--dangerously-load-development-channels)에
                     걸린 실험 기능이라, 그것이 막혔을 때 꺼내 갈 경로가
                     함께 있어야 통째로 막히지 않는다 (§4)
`

/** 인자를 읽는다. 모르는 인자는 무시하지 않고 던진다 — 오타가 조용히 기본값이 되면 안 된다. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): Args {
  let delivery: string | undefined = env.ACM_DELIVERY
  let config = env.ACM_CONFIG ?? DEFAULT_CONFIG_PATH
  let command: Command = 'serve'
  let relay: string | undefined
  let label: string | undefined
  const relayToken = env.ACM_RELAY_TOKEN?.trim() || undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === 'init' || arg === 'whoami') command = arg
    // `hook` 뒤는 훅 런타임의 인자다. 여기서 해석하면 `--event` 가 «모르는
    // 인자» 로 죽고, 훅이 죽으면 에이전트에 따라 프롬프트까지 막힌다.
    else if (arg === 'hook') return { command: 'hook', config, rest: argv.slice(i + 1) }
    else if (arg === '--delivery') delivery = argv[++i]
    else if (arg === '--config') config = argv[++i] ?? config
    else if (arg === '--relay') relay = argv[++i]
    else if (arg === '--label') label = argv[++i]
    else throw new Error(`모르는 인자: ${arg}\n\n${USAGE}`)
  }

  // 전달 방식은 서버를 띄울 때만 필요하다. init 에까지 요구하면
  // 설정을 만들기 전에 전달 방식을 정하라는 말이 된다.
  if (command !== 'serve') return { command, config, relay, relayToken, label }

  if (delivery !== 'push' && delivery !== 'inbox' && delivery !== 'both') {
    throw new Error(
      `--delivery 는 push·inbox·both 중 하나여야 한다 (받은 값: ${delivery ?? '없음'})\n\n${USAGE}`,
    )
  }
  return { command, delivery, config, relay, relayToken, label }
}

/**
 * 명령을 실행한다.
 *
 * `serve` 만 프로세스를 붙잡는다. `init`·`whoami` 는 출력하고 끝나므로
 * 돌려줄 서버가 없다.
 */
export async function main(argv: readonly string[]): Promise<{ stop: () => Promise<void> } | undefined> {
  const args = parseArgs(argv, process.env)

  // 훅은 어떤 경우에도 0 으로 끝나야 하므로 자기 오류 처리를 스스로 한다.
  // 여기서 던지면 아래 진입점이 exit(1) 로 보내 세션을 세운다.
  if (args.command === 'hook') {
    // `--config` 가 `hook` **앞**에 왔으면 rest 에 없다. 그대로 넘기면 훅이
    // 기본 경로를 읽어 다른 신원의 수신함을 보게 된다 — 자리 하나로 오배달이
    // 나는 자리라, 여기서 이미 정해진 경로를 실어 준다 (§6.4).
    const rest = args.rest ?? []
    await hookMain(rest.includes('--config') ? rest : [...rest, '--config', args.config])
    return undefined
  }

  // 사람이 읽는 출력은 stdout 으로 낸다. serve 만 stdout 이 MCP 프레이밍에
  // 묶여 있고, 이 둘은 서버가 아니다.
  if (args.command === 'init') {
    const { path, identity, existed } = await init(args.config, {
      relay: args.relay,
      relayToken: args.relayToken,
    })
    if (existed) {
      // 시드를 덮어쓰면 신원이 사라지고 상대가 대조해 둔 지문이 무효가 된다.
      process.stdout.write(
        `설정이 이미 있다: ${path}\n` + `아무것도 바꾸지 않았다 — 시드를 덮어쓰면 신원을 잃는다.\n`,
      )
      return undefined
    }
    process.stdout.write(
      `설정을 만들었다: ${path} (0600)\n\n` +
        `${whoami(identity, args.label)}\n\n` +
        `다음: 상대와 공개키를 교환하고, 채널 비밀을 만들어 나눈다.\n` +
        `  채널 비밀: ${newChannelSecret()}\n`,
    )
    return undefined
  }

  if (args.command === 'whoami') {
    const { identity } = await buildNode(await loadConfig(args.config))
    process.stdout.write(whoami(identity, args.label) + '\n')
    return undefined
  }

  // 설정이 **아직 없는** 것은 오류가 아니라 첫 실행이다. 여기서 던지면
  // 플러그인을 막 깐 사람에게는 툴이 통째로 사라진 것으로만 보인다 — 설정을
  // 만들라고 말해 줄 자리가 세션 안에 하나도 없다(§11.1). 파일이 있는데
  // 못 읽는 경우는 그대로 던진다: 권한 600 검사(§11)를 여기서 무르게 하면
  // 검사 자체가 없는 것과 같다.
  if (!(await Bun.file(expandHome(args.config)).exists())) {
    process.stderr.write(
      `[agent-channel-mesh] 설정이 없다: ${expandHome(args.config)}\n` +
        `[agent-channel-mesh] 설정 모드로 뜬다 — 세션에서 setup 툴을 부르면 만든다.\n`,
    )
    return await serveSetup({
      configPath: args.config,
      ...(args.relayToken !== undefined ? { relayToken: args.relayToken } : {}),
    })
  }

  const config = await loadConfig(args.config)
  const { node, identity } = await buildNode(config)

  // 지문은 시작할 때 한 번 알린다 — 상대가 대역 외로 대조할 값이다 (§9).
  // 자르지 않고 전부 보여준다. 접두만 보여주면 갈아 맞출 수 있다.
  process.stderr.write(
    `[agent-channel-mesh] ${args.delivery} 모드 · 채널 ${node.channelIds().length}개\n` +
      `[agent-channel-mesh] 내 지문:\n${format(identity.fingerprint)}\n`,
  )

  return await serve({
    node,
    delivery: args.delivery!,
    // 저장소를 **여기서** 세운다. `serve` 가 생략을 기본값으로 메워 주므로
    // 안 넘겨도 서버는 뜨지만, 그러면 설정 파일의 `store.*` 는 검증만 되고
    // 아무 효과가 없다 — 사용자는 보관 기한을 줄였다고 믿는데 30일 기본값이
    // 그대로 돈다. 조용히 무시되는 설정이 없는 설정보다 나쁘다 (§6.3 · §11).
    store: new MessageStore(storeOptionsOf(config.store, identity)),
    onDropped: d => process.stderr.write(`[agent-channel-mesh] 버림: ${d.reason} — ${d.detail}\n`),
  })
}

// 임포트될 때는 아무 일도 하지 않는다 — 테스트가 parseArgs 만 부를 수 있어야 한다.
if (import.meta.main) {
  const server = await main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`[agent-channel-mesh] ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
  // init·whoami 는 돌려줄 서버가 없다. 그대로 끝낸다.
  if (server) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void server.stop().then(() => process.exit(0))
      })
    }
  }
}
