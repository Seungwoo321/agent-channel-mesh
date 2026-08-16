#!/usr/bin/env bun
/**
 * 릴레이 서버 — 로컬·자체 호스팅·서버리스가 같은 파일이다
 *
 * 설계 근거는 docs/architecture.md §10.7.
 *
 *   bun run src/server.ts --port 8787
 *
 * Vercel 의 Bun 프리셋이 고르는 엔트리포인트는 루트 `index.ts` 다. 이 파일은
 * 그 엔트리포인트가 default 로 재수출하는 실제 서버다. 엔트리포인트 모듈의
 * default export 는 함수이거나 Bun Server 여야 하므로, `Bun.serve()` 의 결과를
 * default 로 내보낸다.
 *
 * 라우팅은 `createHandler` 하나가 갖는다. 경로별 파일로 쪼개면 로컬과
 * 배포판의 동작이 갈리고, 그 차이는 배포한 뒤에야 드러난다.
 */
import { keepalive } from './relay/keepalive.js'
import { createHandler } from './relay/http.js'
import { selectStore } from './relay/select-store.js'
import { bindError, parseArgs } from './relay/serve.js'

/**
 * 서버리스인가.
 *
 * 이 플래그가 정하는 것은 **입력의 출처**뿐이다 — 저장소 선택 기준(§ select-store),
 * 인자를 어디서 읽는지, 주소를 우리가 정하는지. 요청 처리 경로는 갈리지 않는다.
 */
const serverless = Boolean(process.env.VERCEL)

function boot(): ReturnType<typeof Bun.serve> {
  // argv 는 CLI 의 편의장치다. 서버리스 엔트리포인트에서는 사용자 입력이
  // 아니라 런타임이 어떻게 실행하느냐의 부산물이므로, 예상 못 한 인자 하나가
  // `모르는 인자` 로 함수를 통째로 못 뜨게 만들 수 있다. 거기서는 환경변수만 읽는다.
  const args = parseArgs(serverless ? [] : process.argv.slice(2), process.env)
  const { store, durable } = selectStore(process.env, args)
  const handler = createHandler({ store })

  const options = {
    // 배포 환경에서는 주소를 우리가 정하지 않는다. Vercel 문서는 `port`/
    // `hostname` 이 로컬에만 적용된다고 하지만 그 말에 기대지 않는다 —
    // 만약 런타임이 덮어쓰지 않으면 함수가 루프백에 묶여 아무 요청도 받지
    // 못하면서 빌드는 성공한다. 넘기지 않으면 그 실패 자체가 불가능하다.
    ...(serverless ? {} : { port: args.port, hostname: args.host }),
    fetch(req: Request) {
      // cron 전용 경로만 여기서 가른다. 나머지는 전부 같은 핸들러가 받는다.
      const path = new URL(req.url).pathname.replace(/\/+$/, '')
      // 메모리 저장소 위에서는 이 경로를 아예 만들지 않는다. keepalive 는
      // Redis 를 건드려 아카이브 타이머를 리셋하는 것이 전부인데, 메모리
      // 저장소에서는 아무 데도 닿지 않으면서 `ok:true` 를 돌려주기 때문이다 —
      // cron 은 성공을 보고, 아카이브는 그대로 진행된다. 할 수 없는 일을
      // 성공으로 답하느니 존재하지 않는 편이 낫다(`createHandler` 가 404 로 답한다).
      if (durable && path === '/keepalive') return keepalive(req, store)
      return handler(req)
    },
  }

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve(options)
  } catch (e) {
    // 서버리스에서는 주소를 넘기지 않았으므로 우리 값으로 설명할 수 없다 —
    // 없는 인자를 지목하느니 원문을 그대로 올린다.
    throw serverless ? e : bindError(e, args)
  }

  // 배포 환경에서는 포트도 주소도 우리가 정한 값이 아니다 — 그 값으로 안내를
  // 찍으면 틀린 주소를 알려주게 되므로 로컬에서만 찍는다.
  if (!serverless) {
    process.stdout.write(
      `릴레이가 떴다: http://${args.host}:${server.port}\n` +
        `  설정의 relay 에 이 주소를 넣는다.\n\n` +
        (durable
          ? `저장소는 Upstash 다.\n`
          : `저장소는 메모리다 — 이 프로세스가 죽으면 대기 중인 봉투가 사라진다.\n`) +
        (args.host === '127.0.0.1'
          ? `이 기계에서만 접근할 수 있다. 외부에 열려면 --host 0.0.0.0 을 준다.\n`
          : `⚠️  외부에 열려 있다. 수신함 조회는 서명으로 인증되지만(§10.12),\n` +
            `   봉투 전송은 누구나 할 수 있고 메타데이터(key id·채널 태그·크기)는\n` +
            `   보는 쪽에 그대로 드러난다. docs/architecture.md §10.12\n`),
    )
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.stop()
      process.exit(0)
    })
  }

  return server
}

let server: ReturnType<typeof Bun.serve>
try {
  server = boot()
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
}

export default server
