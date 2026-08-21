/**
 * 릴레이가 준비됐는지 본다 — 설정을 쓰기 **전에**
 *
 * 설계 근거는 docs/architecture.md §10.7「릴레이」· §11「설정」.
 *
 * 릴레이는 두 가지로 갈리고, 그 둘이 곧 메시를 쓰는 두 상황이다.
 *
 * - **이 기계 안**: 내 클로드와 내 코덱스가 서로 말한다. 릴레이도 내 기계에
 *   떠 있고 저장소는 메모리이며 루프백에만 묶인다. 토큰이 필요 없다.
 * - **배포된 릴레이**: 서로 다른 사람의 에이전트가 만난다. 주소와 쓰기
 *   토큰을 운영하는 사람에게 받아 쓴다.
 *
 * 두 경우 모두 여기서 막고 싶은 고장은 하나다 — **틀린 주소는 오류를 내지
 * 않는다.** 설정은 멀쩡히 만들어지고, 봉투는 아무 데도 닿지 않고, 사용자는
 * 상대가 답을 안 한다고 생각한다. 그래서 주소를 설정에 넣기 전에 한 번
 * 두드려 본다.
 *
 * **릴레이를 대신 띄우지는 않는다.** MCP 서버는 세션과 함께 죽으므로 여기서
 * 띄운 프로세스는 세션보다 오래 살거나(멈출 방법을 아무도 모른다) 세션과
 * 함께 죽는다(상대가 붙어 있는 동안 끊긴다). 대신 **실행할 명령 그대로**를
 * 낸다 — 세션이 백그라운드로 돌리든 사용자가 직접 붙여 넣든 같은 한 줄이고,
 * 무엇이 도는지 사용자 눈에 보인다.
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolResult, ToolSpec } from './tools.js'

/** 로컬 릴레이 기본 포트. `src/relay/serve.ts` 의 `DEFAULT_PORT` 와 같다. */
export const LOCAL_PORT = 8787

/** 로컬 릴레이가 묶이는 주소. 이 기계 밖에서는 닿지 않는다. */
export const LOCAL_HOST = '127.0.0.1'

/** 두드려 보는 데 기다리는 시간. 넘으면 "모른다"가 아니라 "안 닿는다"로 답한다. */
const PROBE_MS = 3_000

export const RELAY_CHECK_TOOL: ToolSpec = {
  name: 'relay_check',
  description:
    '릴레이가 준비됐는지 확인한다. url 을 주면 그 주소를 두드려 보고(이미 배포된 릴레이에 붙는 경우), ' +
    '주지 않으면 이 기계의 로컬 릴레이를 본다 — 안 떠 있으면 띄우는 명령을 그대로 낸다. ' +
    '설정에 주소를 넣기 전에 부른다.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '확인할 릴레이 base URL. 배포된 릴레이에 붙을 때 준다.',
      },
      port: {
        type: 'number',
        description: `로컬 릴레이 포트. 기본 ${String(LOCAL_PORT)}.`,
      },
    },
  },
}

/**
 * 릴레이 실행 파일의 절대 경로.
 *
 * 플러그인에는 **`bun install` 이 일어나지 않는다.** 그래서 마켓플레이스가
 * 받아 둔 `src/server.ts` 를 그대로 부르면 첫 import 에서 모듈을 못 찾고
 * 죽는다 — 릴레이 그래프에 `@noble/hashes` 가 들어 있다. 어댑터와 같은
 * 이유로 릴레이도 번들로 나가고(`plugin/dist/relay.js`), 그 번들은 지금 도는
 * 이 파일과 같은 디렉토리에 있다.
 *
 * 소스에서 돌 때는 그 번들이 없으므로 `src/server.ts` 로 떨어진다. 둘 다
 * 없으면 던진다 — 없는 경로로 명령을 만들어 주면 사용자가 그 명령을 돌리고
 * 나서야 알게 된다.
 */
export function relayEntry(dir: string = import.meta.dir): string {
  const candidates = [join(dir, 'relay.js'), join(dir, '..', 'server.ts')]
  const found = candidates.find(p => existsSync(p))
  if (found === undefined) {
    throw new Error(`릴레이 실행 파일을 찾지 못했다:\n  ${candidates.join('\n  ')}`)
  }
  return found
}

/** 릴레이를 띄우는 명령. 경로를 따옴표로 감싼다 — 공백이 든 경로가 쪼개진다. */
export function relayCommand(port: number, dir?: string): string {
  return `bun "${relayEntry(dir)}" --port ${String(port)}`
}

/** `/health` 가 답하는가. 못 닿는 이유는 그대로 올린다 — 짐작해서 바꾸지 않는다. */
export async function probe(url: string): Promise<{ ok: true } | { ok: false; why: string }> {
  let res: Response
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(PROBE_MS),
    })
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  }
  if (!res.ok) return { ok: false, why: `HTTP ${String(res.status)}` }

  // 200 이지만 릴레이가 아닌 것 — 프록시·로그인 페이지·다른 서버 — 을 여기서
  // 가른다. 몸통을 안 보면 아무 웹서버나 릴레이로 통과한다.
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, why: '200 이지만 JSON 이 아니다 — 릴레이가 아니다' }
  }
  if (typeof body !== 'object' || body === null || (body as { ok?: unknown }).ok !== true) {
    return { ok: false, why: `200 이지만 릴레이 응답이 아니다: ${JSON.stringify(body)}` }
  }
  return { ok: true }
}

export async function runRelayCheck(args: Record<string, unknown>): Promise<ToolResult> {
  const url = typeof args.url === 'string' && args.url.trim() !== '' ? args.url.trim() : undefined
  const port = typeof args.port === 'number' ? args.port : LOCAL_PORT

  if (url !== undefined) return await checkRemote(url)
  return await checkLocal(port)
}

/** 배포된 릴레이 — 서로 다른 사람의 에이전트가 만나는 자리. */
async function checkRemote(url: string): Promise<ToolResult> {
  const seen = await probe(url)
  if (!seen.ok) {
    return {
      text:
        `${url} 은(는) 릴레이로 답하지 않는다: ${seen.why}\n` +
        '주소를 설정에 넣지 않는다 — 틀린 주소는 오류 없이 조용히 아무것도 나르지 않는다. ' +
        '릴레이를 운영하는 사람에게 주소를 다시 확인한다.',
      isError: true,
    }
  }
  return {
    text:
      `${url} 이(가) 릴레이로 답했다. setup 또는 relay_set 의 relay 에 이 주소를 넣는다.\n` +
      '쓰기 토큰이 필요한지는 여기서 알 수 없다 — /health 는 인증을 요구하지 않는다. ' +
      '운영하는 사람이 토큰을 줬다면 함께 넣는다.\n' +
      '이 릴레이는 여러 사람이 함께 쓰는 자리다. 채널 축은 external 이고, ' +
      '도착한 말은 기본 권한이 읽기다.',
  }
}

/** 로컬 릴레이 — 이 기계 안의 내 에이전트들이 만나는 자리. */
async function checkLocal(port: number): Promise<ToolResult> {
  const url = `http://${LOCAL_HOST}:${String(port)}`
  const seen = await probe(url)
  if (seen.ok) {
    return {
      text:
        `로컬 릴레이가 이미 떠 있다: ${url}\n` +
        'setup 또는 relay_set 의 relay 에 이 주소를 넣는다.',
    }
  }

  let command: string
  try {
    command = relayCommand(port)
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true }
  }

  return {
    text:
      `${url} 에는 아직 릴레이가 없다 (${seen.why}).\n` +
      '이 명령으로 띄운다 — 세션이 백그라운드로 돌려도 되고, 사용자가 다른 터미널에서 직접 돌려도 된다:\n\n' +
      `  ${command}\n\n` +
      `떴으면 relay 에 ${url} 을 넣는다.\n` +
      `${LOCAL_HOST} 에만 묶이므로 이 기계 밖에서는 닿지 않는다 — 내 클로드와 내 코덱스를 잇는 용도다. ` +
      '저장소는 메모리라 프로세스가 죽으면 대기 중인 봉투가 사라지고, 그래서 릴레이는 두 에이전트가 ' +
      '말하는 동안 계속 떠 있어야 한다.\n' +
      '다른 사람과 이어지려면 이 릴레이가 아니라 배포된 릴레이가 필요하다.',
  }
}

/**
 * 배포용 `vercel.json`. 레포 루트의 것과 **같아야 한다** — 그 파일이 실제로
 * 떠 있는 릴레이를 만든 설정이다. 여기 다시 적는 이유는 플러그인에는 레포가
 * 없기 때문이고, 어긋나지 않는지는 테스트가 두 파일을 대조해 지킨다.
 */
export const VERCEL_JSON = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  framework: 'bun',
  bunVersion: '1.x',
  crons: [{ path: '/keepalive', schedule: '0 21 * * 0' }],
}

/**
 * 배포 디렉토리의 진입점.
 *
 * 레포와 같은 모양이다 — Vercel 의 Bun 프리셋이 찾는 이름은 `index` 이고,
 * 그 모듈의 default export 가 서버여야 한다. 실제 서버는 옆의 번들이 갖는다.
 *
 * specifier 가 `.js` 인 것은 관례가 아니라 요구다. Vercel 은 배포 전에 `.ts` 를
 * 전부 `.js` 로 바꾸므로 런타임 디스크에 `.ts` 가 없고, `.ts` specifier 는 없는
 * 파일을 가리켜 **빌드는 성공한 채 매 요청이 죽는다**.
 */
const INDEX_TS = `export { default } from './relay.js'\n`

const PACKAGE_JSON = {
  name: 'agent-channel-mesh-relay',
  private: true,
  type: 'module',
}

export const RELAY_EXPORT_TOOL: ToolSpec = {
  name: 'relay_export',
  description:
    '배포할 수 있는 릴레이 디렉토리를 만든다 — 릴레이를 직접 운영해서 다른 사람들과 쓰려는 경우. ' +
    '레포를 클론하지 않는다. 만든 뒤 배포 명령은 사용자가 자기 계정으로 돌린다.',
  inputSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '만들 디렉토리 경로. 없으면 만든다.' },
    },
    required: ['dir'],
  },
}

/**
 * 배포 디렉토리를 쓴다.
 *
 * 배포까지 하지 않는다 — 배포는 사용자의 Vercel 계정·과금·도메인이 걸린
 * 일이고, 되돌리는 것도 사용자만 할 수 있다. 여기서 만드는 것은 `vercel`
 * 이 그대로 올릴 수 있는 파일 네 개까지다.
 */
export async function runRelayExport(args: Record<string, unknown>): Promise<ToolResult> {
  const dir = typeof args.dir === 'string' ? args.dir.trim() : ''
  if (dir === '') return { text: 'dir 이 필요하다 — 릴레이를 만들 디렉토리를 사용자에게 받는다.', isError: true }

  let entry: string
  try {
    entry = relayEntry()
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true }
  }
  if (entry.endsWith('.ts')) {
    return {
      text:
        `릴레이 번들이 없다 (${entry} 는 소스다). 플러그인으로 깐 것이 아니라 레포에서 도는 중이라면 ` +
        '`bun run plugin` 으로 번들을 먼저 뽑는다.',
      isError: true,
    }
  }

  try {
    await mkdir(dir, { recursive: true })
    await copyFile(entry, join(dir, 'relay.js'))
    await writeFile(join(dir, 'index.ts'), INDEX_TS)
    await writeFile(join(dir, 'vercel.json'), `${JSON.stringify(VERCEL_JSON, null, 2)}\n`)
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`)
  } catch (e) {
    return { text: `릴레이 디렉토리를 만들지 못했다: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }

  return {
    text:
      `${dir} 에 릴레이를 만들었다 (index.ts · relay.js · vercel.json · package.json).\n\n` +
      '여기서부터는 사용자의 계정이 필요하다 — 아래를 사용자가 직접 돌린다:\n\n' +
      `  cd ${dir}\n` +
      '  vercel link\n' +
      '  vercel env add ACM_RELAY_STORE production # 값을 turso 또는 upstash 중 하나로 입력\n' +
      '  # Turso를 고르는 경우에만:\n' +
      '  turso db create <database-name>\n' +
      '  turso db show <database-name> --url\n' +
      '  turso db tokens create <database-name>\n' +
      '  vercel env add TURSO_DATABASE_URL production\n' +
      '  vercel env add TURSO_AUTH_TOKEN production\n' +
      '  # Upstash를 고르는 경우에만:\n' +
      '  vercel integration add upstash\n' +
      '  # 아래 두 값은 Turso·Upstash 공통:\n' +
      '  openssl rand -hex 32                  # 쓰기 토큰을 만든다\n' +
      '  vercel env add ACM_RELAY_TOKEN production\n' +
      '  vercel env add CRON_SECRET production # keepalive cron 인증\n' +
      '  vercel deploy --prod\n\n' +
      '뜬 뒤 relay_check 에 그 주소를 줘서 릴레이로 답하는지 확인한다.\n' +
      '주소와 쓰기 토큰을 함께 쓸 사람들에게 대역 외로 나눈다 — 채널 비밀과는 다른 값이고, ' +
      '토큰은 릴레이에 올릴 권한일 뿐 본문을 열지는 못한다.',
  }
}
