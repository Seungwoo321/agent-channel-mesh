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
import { loadConfig, buildNode, DEFAULT_CONFIG_PATH } from './config.ts'
import { serve, type Delivery } from './server.ts'
import { init, whoami, newChannelSecret } from './onboard.ts'
import { format } from '../identity/fingerprint.ts'

/** 무엇을 하러 왔는가. `serve` 만 전달 방식을 요구한다. */
export type Command = 'serve' | 'init' | 'whoami'

export interface Args {
  readonly command: Command
  /** `serve` 일 때만 의미가 있다. */
  readonly delivery?: Delivery
  readonly config: string
  /** `init` 에서 설정에 박아 둘 릴레이 URL. */
  readonly relay?: string
  /** `init`·`whoami` 에서 쓸 이름. 신뢰의 근거가 아니다 — 근거는 지문뿐이다(§9). */
  readonly label?: string
}

const USAGE = `agent-channel-mesh

  init                    설정을 만든다 (시드 생성 + 0600)
  whoami                  상대에게 보낼 공개키와 내 지문을 보여준다
  --delivery <push|inbox> 어댑터를 띄운다

  --config <path>   기본값 ${DEFAULT_CONFIG_PATH} (환경변수 ACM_CONFIG 로도 지정)
  --relay <url>     init 이 설정에 박아 둘 릴레이 URL
  --label <name>    내 이름 (기본값: 내이름)

  --delivery push    Claude Code — 세션에 능동 주입한다
  --delivery inbox   그 외 에이전트(Codex 등) — 수신함에 쌓고 inbox 툴로 꺼낸다
`

/** 인자를 읽는다. 모르는 인자는 무시하지 않고 던진다 — 오타가 조용히 기본값이 되면 안 된다. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = {}): Args {
  let delivery: string | undefined = env.ACM_DELIVERY
  let config = env.ACM_CONFIG ?? DEFAULT_CONFIG_PATH
  let command: Command = 'serve'
  let relay: string | undefined
  let label: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === 'init' || arg === 'whoami') command = arg
    else if (arg === '--delivery') delivery = argv[++i]
    else if (arg === '--config') config = argv[++i] ?? config
    else if (arg === '--relay') relay = argv[++i]
    else if (arg === '--label') label = argv[++i]
    else throw new Error(`모르는 인자: ${arg}\n\n${USAGE}`)
  }

  // 전달 방식은 서버를 띄울 때만 필요하다. init 에까지 요구하면
  // 설정을 만들기 전에 전달 방식을 정하라는 말이 된다.
  if (command !== 'serve') return { command, config, relay, label }

  if (delivery !== 'push' && delivery !== 'inbox') {
    throw new Error(`--delivery 는 push 또는 inbox 여야 한다 (받은 값: ${delivery ?? '없음'})\n\n${USAGE}`)
  }
  return { command, delivery, config, relay, label }
}

/**
 * 명령을 실행한다.
 *
 * `serve` 만 프로세스를 붙잡는다. `init`·`whoami` 는 출력하고 끝나므로
 * 돌려줄 서버가 없다.
 */
export async function main(argv: readonly string[]): Promise<{ stop: () => Promise<void> } | undefined> {
  const args = parseArgs(argv, process.env)

  // 사람이 읽는 출력은 stdout 으로 낸다. serve 만 stdout 이 MCP 프레이밍에
  // 묶여 있고, 이 둘은 서버가 아니다.
  if (args.command === 'init') {
    const { path, identity, existed } = await init(args.config, { relay: args.relay })
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
