/**
 * 훅 런타임 — 도착한 메시지를 세션 컨텍스트에 밀어 넣는다
 *
 * 설계 근거는 docs/architecture.md §6.6「도착을 세션이 알게 하는 세 경로」.
 *
 * MCP 서버는 세션에 먼저 말을 걸지 못한다. 채널 주입(§4)은 Claude 의 개발
 * 플래그에 걸려 있고, Codex 에는 그 경로가 아예 없다. 남는 것이 훅이다 —
 * **두 에이전트 모두 같은 형식**이고, 둘 다 `hookSpecificOutput.additionalContext`
 * 로 모델 컨텍스트에 실제로 들어간다(사용자에게만 보이는 `systemMessage` 와
 * 다르다). 그래서 이 스크립트는 에이전트별로 갈리지 않는다.
 *
 * **릴레이를 치지 않는다**(§4·CLAUDE.md). 드레인하는 곳은 코어의 루프
 * 하나뿐이다 — 큐는 꺼내면 사라지므로 훅이 따로 치면 어댑터의 메시지를
 * 훔친다. 여기서 읽는 것은 로컬 저장소뿐이고, 그것이 정본이다(§6.3).
 *
 * **이 스크립트는 안전망이지 알림이 아니다.** 주입이 도는 세션에서는
 * 어댑터가 이미 전달 표시를 찍어 두므로 여기서는 아무것도 안 나온다.
 * 주입이 실패했거나 세션이 놓쳤을 때만 뜬다.
 */
import { loadConfig, storeOptionsOf, expandHome, DEFAULT_CONFIG_PATH } from '../adapter/config.js'
import { MessageStore, type StoredMessage } from '../store/store.js'
import { renderBundle } from '../adapter/bundle.js'

/**
 * 한 번에 실어 보내는 최대 건수.
 *
 * 훅 출력은 모델 컨텍스트로 **그대로** 들어간다. 밀린 큐가 수백 건이면 그
 * 턴의 컨텍스트를 통째로 밀어내고, 그건 알림이 아니라 사고다. Codex 는
 * `additionalContextLimit` 로 잘라 내기까지 하므로 넘기면 **말이 중간에서
 * 끊긴다** — 우리가 세어서 자르고 남은 수를 알려 주는 편이 낫다.
 *
 * 남긴 것은 선점하지 않으므로 다음 훅이 이어서 집는다. 유실이 아니다.
 */
export const HOOK_BATCH_LIMIT = 20

/**
 * 한 번에 실어 보내는 최대 글자 수.
 *
 * 건수만 세면 부족하다 — 20건이라도 본문이 길면 얼마든지 커진다. 그리고
 * Codex 는 `additionalContextLimit` 로 **넘친 만큼을 그냥 잘라 낸다**. 잘린
 * 자리는 문장 중간이라 모델은 그것이 잘린 줄 모르고 읽는다. 그래서 우리가
 * 먼저 **메시지 단위로** 끊는다 — 자를 거면 말 중간이 아니라 말 사이에서
 * 자르고, 몇 건이 남았는지 알린다.
 *
 * 설치기가 `additionalContextLimit` 을 이 값보다 넉넉히 잡아 두므로,
 * 정상 경로에서 에이전트 쪽 절단은 일어나지 않는다.
 */
export const HOOK_CONTEXT_LIMIT = 8000

/**
 * 남은 건수 안내에 미리 비워 두는 자리.
 *
 * 본문을 예산에 꽉 채워 고른 뒤 안내를 얹으면 **합이 예산을 넘는다** — 그러면
 * 넘긴 만큼을 에이전트가 잘라 내고, 우리가 메시지 단위로 끊어 둔 의미가
 * 사라진다. 그래서 본문은 처음부터 이만큼 좁은 예산으로 고른다.
 */
const NOTICE_RESERVE = 120

/** 우리가 잘랐다고 밝히는 꼬리표에 비워 두는 자리. */
const CLIP_NOTE_RESERVE = 60

/** 이 값들만 `hookEventName` 으로 되돌려준다. 모르는 이벤트는 조용히 지나간다. */
const KNOWN_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PreCompact',
  'Stop',
])

export interface HookOutput {
  readonly continue: true
  readonly suppressOutput: true
  readonly hookSpecificOutput?: {
    readonly hookEventName: string
    readonly additionalContext: string
  }
}

/**
 * 저장소에서 미전달분을 **선점해** 렌더한다.
 *
 * 조회가 아니라 선점인 이유: 어댑터는 별개 프로세스로 같은 저장소를 본다.
 * 조회는 흔적을 안 남기므로 어댑터가 주입하는 동안 훅이 같은 메시지를 집어
 * 들고, 세션에는 같은 말이 두 번 뜬다(§6.6 "중복은 상태로 막는다").
 *
 * `markDelivered` 는 **출력이 나간 뒤에** 찍는다. 먼저 찍고 죽으면 그
 * 메시지는 어디에도 도달하지 못한 채 사라지지만, 나중에 찍고 죽으면 리스
 * 기한 뒤에 한 번 더 뜰 뿐이다. 중복은 보이고 유실은 안 보인다.
 */
export async function collect(store: MessageStore): Promise<string> {
  const batch = await store.claimUndelivered(undefined, HOOK_BATCH_LIMIT)
  if (batch.length === 0) return ''

  const keep = fit(batch)
  const drop = batch.slice(keep.length)

  try {
    // 예산 밖은 **곧바로 풀어 준다.** 선점만 남기면 리스 기한(기본 60초)
    // 동안 어댑터에도 다음 훅에도 안 보인다 — 이번 턴에 안 실었을 뿐
    // 다음 턴에는 바로 나가야 한다.
    //
    // 풀지 못해도 이번 배치를 접지 않는다. 못 푼 것은 기한이 지나면 저절로
    // 풀리지만, 여기서 던지면 이미 고른 `keep` 까지 같이 밀린다.
    if (drop.length > 0) {
      await store.release(drop.map(m => m.id)).catch(warn('예산 밖 선점을 풀지 못했다'))
    }

    // 여기서 세는 미전달에는 방금 선점한 `keep` 도 포함돼 있다(선점은
    // 조회를 가리지 않는다) — 그만큼 뺀 나머지가 "더 있는" 건수다.
    const left = Math.max(0, (await store.undelivered()).length - keep.length)
    const text = render(keep, left)

    // 표시가 실패해도 **본문은 내보낸다.** 여기서 던지면 이미 만들어 둔 말이
    // 사라진다. 게다가 `markDelivered` 는 채널을 하나씩 잠그고 돌기 때문에
    // 일부만 찍힌 채 죽을 수 있고, 그렇게 찍힌 것은 다음 훅에도 안 나온다 —
    // 안전망이 삼킨 것이다. 표시 실패의 대가는 다음 훅에서 한 번 더 뜨는
    // 것뿐이다. 중복은 보이고 유실은 안 보인다(§6.3).
    const ids = keep.map(m => m.id)
    await store.markDelivered(ids).catch(async (e: unknown) => {
      warn('전달 표시에 실패했다')(e)
      // 못 찍은 것은 선점만 남는다. 그대로 두면 리스 기한(기본 60초) 동안
      // 어댑터에도 다음 훅에도 안 보인다 — 이미 내보낸 본문이 있으니 유실은
      // 아니지만, 그 창 동안 뒤이어 온 말까지 같이 늦는다. 풀어 두면 다음
      // 훅이 곧바로 집는다. 이미 찍힌 것은 `delivered` 라 다시 안 나온다.
      await store.release(ids).catch(warn('표시 실패 뒤 선점을 풀지 못했다'))
    })
    return text
  } catch (e) {
    // 어디서 죽든 선점은 풀고 나간다. 안 그러면 기한까지 아무도 못 집는다.
    await store.release(batch.map(m => m.id)).catch(() => undefined)
    throw e
  }
}

/**
 * 글자 예산 안에 들어가는 앞부분만 남긴다.
 *
 * 예산을 넘겨도 **한 건은 반드시 남긴다.** 첫 메시지 하나가 예산보다 클 수
 * 있는데, 그때 전부 버리면 그 메시지는 영원히 나가지 못하고 훅이 매 프롬프트
 * 같은 일을 반복한다 — 진행이 없는 안전망은 안전망이 아니다.
 *
 * 자르는 단위는 메시지다. 렌더 결과를 글자로 자르면 마지막 말이 문장 중간에서
 * 끊기고, 모델은 그것이 원문인 줄 안다.
 */
function fit(batch: readonly StoredMessage[]): readonly StoredMessage[] {
  const budget = HOOK_CONTEXT_LIMIT - NOTICE_RESERVE
  for (let n = batch.length; n > 1; n--) {
    if (renderBundle(batch.slice(0, n), { markNew: true }).length <= budget) {
      return batch.slice(0, n)
    }
  }
  return batch.slice(0, 1)
}

/**
 * 한 건이 예산보다 크면 **우리가** 자르고, 잘랐다고 밝힌다.
 *
 * 그대로 내보내면 에이전트 쪽 상한(Codex `additionalContextLimit`)이 넘친
 * 만큼을 말없이 잘라 내고, 잘린 자리가 문장 중간이라 모델은 그것이 원문인 줄
 * 안다. 어차피 잘릴 것이면 **보이게** 자른다 — 모델이 전문이 따로 있다는 것을
 * 알면 `inbox` 툴로 이어 읽을 수 있다.
 */
function clip(body: string): string {
  const budget = HOOK_CONTEXT_LIMIT - NOTICE_RESERVE
  if (body.length <= budget) return body
  const head = Math.max(0, budget - CLIP_NOTE_RESERVE)
  const omitted = body.length - head
  return `${body.slice(0, head)}\n…(${String(omitted)}자 생략됐다 — inbox 툴로 전문을 읽어라.)`
}

function render(batch: readonly StoredMessage[], left: number): string {
  const body = clip(renderBundle(batch, { markNew: true }))
  if (left <= 0) return body
  // 자른 사실을 감추지 않는다. 모델이 "이게 전부"라고 읽으면 남은 것은
  // 없는 것과 같아진다.
  return `${body}\n\n(${String(left)}건이 더 있다 — inbox 툴로 이어서 읽어라.)`
}

/** 실패를 삼키되 흔적은 남긴다. stdout 은 훅 출력 전용이라 stderr 로만 쓴다. */
function warn(what: string): (e: unknown) => void {
  return (e: unknown) => {
    process.stderr.write(`[agent-channel-mesh] ${what}: ${String(e)}\n`)
  }
}

/**
 * 훅 한 번을 처리해 stdout 에 실을 것을 만든다.
 *
 * `event` 는 **인자로 받는다.** stdin 페이로드의 필드 이름은 에이전트마다
 * 다르고(`hook_event_name` · `hookEventName`), 추측이 틀리면 출력이 조용히
 * 무시된다 — CLAUDE.md 의 `--delivery` 와 같은 이유로 명시로 정한다.
 *
 * **실을 곳이 없으면 집지도 않는다.** 모르는 이벤트에서 먼저 드레인하고 나서
 * 출력을 버리면, 그 메시지는 `delivered` 로 찍힌 채 어디에도 도달하지 못한다 —
 * 안전망이 삼킨 메시지는 다시 잡아 줄 다음 그물이 없다. 그래서 이벤트 판정이
 * 저장소 접근보다 **먼저** 온다.
 */
export async function runHook(event: string, store: MessageStore): Promise<HookOutput> {
  if (!KNOWN_EVENTS.has(event)) return { continue: true, suppressOutput: true }

  const text = await collect(store)
  if (text === '') {
    return { continue: true, suppressOutput: true }
  }
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  }
}

/** `--event <이름>` 만 읽는다. 없으면 빈 문자열 — 그러면 아무것도 안 싣는다. */
export function parseEvent(argv: readonly string[]): string {
  const i = argv.indexOf('--event')
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? '') : ''
}

/**
 * 이 훅이 읽을 설정 파일 (§6.4).
 *
 * 우선순위는 `--config` → `ACM_CONFIG` → 기본값이다. 플래그가 환경변수를
 * 이기는 이유는 **설치기가 쓰는 쪽이 플래그**이기 때문이다 — 에이전트가
 * 물려주는 환경에 `ACM_CONFIG` 가 남아 있다고 해서, 설치기가 그 에이전트용
 * 으로 못 박아 둔 신원이 뒤집히면 안 된다.
 */
export function parseConfigPath(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  const i = argv.indexOf('--config')
  const flag = i >= 0 ? argv[i + 1] : undefined
  if (flag !== undefined && flag !== '' && !flag.startsWith('--')) return flag
  const fromEnv = env.ACM_CONFIG?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_CONFIG_PATH
}

/**
 * 진입점.
 *
 * **어떤 경우에도 0 으로 끝난다.** 훅이 실패 코드를 내면 에이전트에 따라
 * 프롬프트 자체가 막히거나 사용자에게 오류가 뜬다 — 메시지 알림 하나가
 * 세션을 세우는 것은 안전망이 만드는 사고다. 진단은 stderr 로만 남긴다.
 */
export async function hookMain(argv: readonly string[]): Promise<void> {
  await run(argv).catch((e: unknown) => {
    process.stderr.write(`[agent-channel-mesh] 훅이 실패했다: ${String(e)}\n`)
    // 실패해도 세션은 계속 간다. 출력이 없으면 에이전트는 그냥 지나친다.
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }))
  })
}

/**
 * 설정이 아직 없을 때 세션에 하는 말.
 *
 * **세션 시작에만 한다.** `PostToolUse` 는 툴 호출마다 도는 훅이라(§6.6)
 * 거기서도 말하면 설정을 만들 때까지 매 호출에 같은 문장이 실린다 —
 * 안내가 아니라 소음이고, 컨텍스트를 밀어낸다.
 */
export const SETUP_HINT =
  'agent-channel-mesh is installed but has no identity yet. ' +
  'Its setup tool is the only tool it exposes right now — ' +
  'ask the user for a relay URL and a display name, then call it. ' +
  'Mention this only if the user brings up messaging; do not interrupt their task for it.'

async function run(argv: readonly string[]): Promise<void> {
  const path = parseConfigPath(argv)

  // 설정이 없는 것은 첫 실행이다(§11.1). 조용히 지나가면 훅이 깔린 줄도
  // 모른 채 며칠이 가므로, 시작할 때 한 번만 알린다. 파일이 있는데 못 읽는
  // 경우는 아래에서 그대로 던진다 — 권한 검사(§11)를 삼키면 안 된다.
  if (!(await Bun.file(expandHome(path)).exists())) {
    const event = parseEvent(argv)
    const out: HookOutput =
      event === 'SessionStart'
        ? {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: { hookEventName: event, additionalContext: SETUP_HINT },
          }
        : { continue: true, suppressOutput: true }
    process.stdout.write(JSON.stringify(out))
    return
  }

  const config = await loadConfig(path)
  const store = new MessageStore(storeOptionsOf(config.store))
  const out = await runHook(parseEvent(argv), store)
  process.stdout.write(JSON.stringify(out))
}

if (import.meta.main) await hookMain(process.argv.slice(2))
