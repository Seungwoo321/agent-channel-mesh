/**
 * 훅 런타임 테스트 (§6.6 안전망)
 *
 * 여기서 지키는 것은 세 가지다 — 어댑터와 훅이 같은 메시지를 **두 번** 세션에
 * 넣지 않는 것, 컨텍스트 예산을 넘길 때 **말 중간이 아니라 말 사이에서** 끊고
 * 남은 수를 알리는 것, 그리고 어떤 실패도 메시지를 **영영 못 보게 만들지**
 * 않는 것.
 *
 * 마지막 항목이 핵심이다. 훅은 안전망이라, 안전망이 조용히 삼킨 메시지는
 * 다시 잡아 줄 다음 그물이 없다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore, type NewMessage } from '../src/store/store.js'
import {
  collect,
  runHook,
  parseEvent,
  parseConfigPath,
  HOOK_BATCH_LIMIT,
  HOOK_CONTEXT_LIMIT,
} from '../src/install/notify.js'
import { DEFAULT_CONFIG_PATH } from '../src/adapter/config.js'
import { readTaint } from '../src/policy/taint.js'

let dir: string
let store: MessageStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-hook-'))
  store = new MessageStore({ dir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const A = 'aa11'

function inbound(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    channelId: A,
    direction: 'in',
    axis: 'external',
    senderLabel: 'bob',
    text: '안녕',
    sentAt: 1_000,
    ...overrides,
  }
}

async function seed(n: number, text = (i: number) => `메시지 ${String(i)}`): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.append(inbound({ text: text(i), sentAt: 1_000 + i }))
  }
}

describe('무엇을 싣는가', () => {
  test('미전달이 없으면 아무것도 싣지 않는다', async () => {
    expect(await collect(store)).toBe('')
  })

  test('미전달을 본문에 싣는다', async () => {
    await seed(2)
    const text = await collect(store)
    expect(text).toContain('메시지 0')
    expect(text).toContain('메시지 1')
  })

  test('발신은 싣지 않는다 — 주입 대상이 아니다', async () => {
    await store.append(inbound({ direction: 'out', text: '내가 한 말' }))
    expect(await collect(store)).toBe('')
  })

  test('이미 전달된 것은 다시 싣지 않는다', async () => {
    await seed(1)
    expect(await collect(store)).not.toBe('')
    // 두 번째 호출이 같은 말을 또 실으면, 그것이 세션에 두 번 뜨는 그 고장이다.
    expect(await collect(store)).toBe('')
  })
})

describe('예산 (건수 · 글자)', () => {
  test(`${String(HOOK_BATCH_LIMIT)}건까지만 싣고 남은 수를 알린다`, async () => {
    await seed(HOOK_BATCH_LIMIT + 5)
    const text = await collect(store)
    expect(text).toContain('메시지 0')
    expect(text).toContain(`메시지 ${String(HOOK_BATCH_LIMIT - 1)}`)
    expect(text).not.toContain(`메시지 ${String(HOOK_BATCH_LIMIT)}`)
    expect(text).toContain('5건이 더 있다')
  })

  test('남긴 것은 다음 훅이 이어서 집는다 — 유실이 아니다', async () => {
    await seed(HOOK_BATCH_LIMIT + 5)
    await collect(store)
    const next = await collect(store)
    expect(next).toContain(`메시지 ${String(HOOK_BATCH_LIMIT)}`)
    expect(next).toContain(`메시지 ${String(HOOK_BATCH_LIMIT + 4)}`)
  })

  test('글자 예산을 넘기지 않는다', async () => {
    // 한 건당 2천 자 — 20건 한도 안이지만 글자로는 4만 자다.
    await seed(20, i => `${String(i)}${'가'.repeat(2000)}`)
    const text = await collect(store)
    // 남은 건수 안내를 뺀 본문이 예산 안이어야 한다.
    const body = text.split('\n\n(')[0] ?? ''
    expect(body.length).toBeLessThanOrEqual(HOOK_CONTEXT_LIMIT)
    expect(text).toContain('건이 더 있다')
  })

  test('예산 밖은 곧바로 풀어 다음 훅에서 바로 나온다', async () => {
    await seed(20, i => `${String(i)}${'가'.repeat(2000)}`)
    await collect(store)
    // 선점만 걸어 두고 놓아 주지 않으면 리스 기한(60초)까지 아무 데도 안 뜬다.
    // 다음 호출이 곧바로 뭔가를 실어야 그 창이 없다는 뜻이다.
    expect(await collect(store)).not.toBe('')
  })

  test('한 건이 예산보다 커도 그 한 건은 나간다', async () => {
    // 전부 버리면 이 메시지는 영원히 못 나가고 훅은 매번 같은 일을 반복한다.
    await store.append(inbound({ text: '표식' + '가'.repeat(HOOK_CONTEXT_LIMIT * 2) }))
    const text = await collect(store)
    expect(text).toContain('표식')
    expect(await store.undelivered()).toHaveLength(0)
  })
})

describe('실패해도 메시지를 잃지 않는다', () => {
  test('표시가 실패해도 본문은 나가고, 다음 훅이 다시 집는다', async () => {
    await seed(2)
    store.markDelivered = () => Promise.reject(new Error('디스크가 죽었다'))

    // 표시 실패로 본문을 접으면, 그때 이미 찍힌 것이 있으면 그건 영영 안
    // 보인다. 표시 실패의 대가는 유실이 아니라 중복이어야 한다.
    const text = await collect(store)
    expect(text).toContain('메시지 0')
    expect(text).toContain('메시지 1')

    // 못 찍었으므로 다음 훅에서 한 번 더 뜬다 — 보이는 대가다.
    const fresh = new MessageStore({ dir })
    expect(await fresh.claimUndelivered()).toHaveLength(2)
  })
})

describe('훅 출력', () => {
  test('실을 것이 없으면 컨텍스트를 붙이지 않는다', async () => {
    expect(await runHook('SessionStart', store)).toEqual({
      continue: true,
      suppressOutput: true,
    })
  })

  test('아는 이벤트면 additionalContext 로 싣는다', async () => {
    await seed(1)
    const out = await runHook('UserPromptSubmit', store)
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit')
    expect(out.hookSpecificOutput?.additionalContext).toContain('메시지 0')
    // 사용자 화면에는 안 띄운다 — 모델 컨텍스트에만 들어가면 된다.
    expect(out.suppressOutput).toBe(true)
  })

  test('모르는 이벤트면 컨텍스트를 붙이지 않는다', async () => {
    await seed(1)
    const out = await runHook('NotAnEvent', store)
    expect(out.hookSpecificOutput).toBeUndefined()
  })

  test('--event 를 읽는다', () => {
    expect(parseEvent(['--event', 'PostToolUse'])).toBe('PostToolUse')
    expect(parseEvent([])).toBe('')
    expect(parseEvent(['--event'])).toBe('')
  })
})

describe('프로세스로 돌려도 세션을 세우지 않는다', () => {
  test('설정이 없어도 0 으로 끝나고 계속 진행을 낸다', async () => {
    // 훅이 실패 코드를 내면 에이전트에 따라 프롬프트 자체가 막힌다.
    const proc = Bun.spawn(
      ['bun', 'run', join(import.meta.dir, '..', 'src', 'install', 'notify.ts'), '--event', 'Stop'],
      {
        env: { ...process.env, ACM_CONFIG: join(dir, '없는파일.json') },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ continue: true, suppressOutput: true })
    // 서브프로세스를 새로 띄우는 테스트다 — 전체 스위트와 같이 돌 때는 런타임
    // 기동만으로 기본 제한(5초)을 넘긴다. 기다리는 시간을 넉넉히 준다.
  }, 30_000)
})

/**
 * 어느 설정을 읽는가 (§6.4)
 *
 * 설치기가 훅에 못 박아 둔 신원이, 에이전트가 물려주는 환경변수 하나에
 * 뒤집히면 안 된다 — 그러면 두 에이전트가 조용히 같은 수신함을 보게 된다.
 */
describe('parseConfigPath (§6.4)', () => {
  test('--config 가 ACM_CONFIG 를 이긴다', () => {
    expect(parseConfigPath(['--config', '/a.json'], { ACM_CONFIG: '/b.json' })).toBe('/a.json')
  })

  test('--config 가 없으면 ACM_CONFIG', () => {
    expect(parseConfigPath(['--event', 'Stop'], { ACM_CONFIG: '/b.json' })).toBe('/b.json')
  })

  test('둘 다 없으면 기본 경로', () => {
    expect(parseConfigPath([], {})).toBe(DEFAULT_CONFIG_PATH)
  })

  test('값이 비었거나 다음 플래그면 못 본 것으로 친다', () => {
    expect(parseConfigPath(['--config'], {})).toBe(DEFAULT_CONFIG_PATH)
    expect(parseConfigPath(['--config', '--event', 'Stop'], {})).toBe(DEFAULT_CONFIG_PATH)
  })

  test('공백뿐인 ACM_CONFIG 는 없는 것과 같다', () => {
    expect(parseConfigPath([], { ACM_CONFIG: '   ' })).toBe(DEFAULT_CONFIG_PATH)
  })
})

/**
 * 전달과 오염 (§8.3)
 *
 * 훅이 세션에 실어 보내는 것은 곧 동료의 말이 컨텍스트에 들어가는 것이다.
 * 그 순간 오염이 찍혀 있지 않으면, 그 말이 그대로 툴 호출을 연다.
 */
describe('전달하면 오염이 찍힌다', () => {
  test('동료의 말을 실으면 그 권한으로 오염이 남는다', async () => {
    await store.append(inbound({ authority: 'peer', grant: 'read' }))
    await runHook('PostToolUse', store)
    expect(await readTaint(store.directory)).toMatchObject({ grant: 'read', from: 'bob' })
  })

  test('내 다른 에이전트의 말은 오염을 남기지 않는다', async () => {
    await store.append(inbound({ axis: 'internal', authority: 'self', grant: 'execute' }))
    await runHook('PostToolUse', store)
    expect(await readTaint(store.directory)).toBeUndefined()
  })

  test('사용자가 입력하면 풀린다 — 그것이 "내가 시킨 것"의 유일한 신호다', async () => {
    await store.append(inbound({ authority: 'peer', grant: 'read' }))
    await runHook('PostToolUse', store)
    await runHook('UserPromptSubmit', store)
    expect(await readTaint(store.directory)).toBeUndefined()
  })

  test('푸는 것이 집는 것보다 먼저다 — 같이 실린 말까지 지우면 안 된다', async () => {
    // 이번 프롬프트에 딸려 들어온 동료 발화는 오염 없이 세션에 들어가면 안 된다.
    await store.append(inbound({ authority: 'peer', grant: 'read' }))
    const out = await runHook('UserPromptSubmit', store)
    expect(out.hookSpecificOutput?.additionalContext).toContain('안녕')
    expect(await readTaint(store.directory)).toMatchObject({ grant: 'read' })
  })
})
