/**
 * 오염 상태와 게이트 테스트 (§8.3「권한은 훅이 강제한다」)
 *
 * 훅은 툴 호출마다 새로 뜨는 별개 프로세스라, 상태 파일 하나가 "동료의 말이
 * 아직 이 세션에 살아 있는가"의 유일한 근거다. 그래서 여기서 지키는 것은
 * 두 가지다 — 그 파일이 **좁은 쪽으로만** 틀리는 것, 그리고 판정을 못 하는
 * 상황이 곧 거부인 것(페이로드를 못 읽게 만드는 것이 우회 수단이 되면 안 된다).
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addTaint,
  clearTaint,
  readTaint,
  taintPathOf,
  TAINT_VERSION,
  verdict,
  type TaintSource,
} from '../src/policy/taint.js'
import { runGate, toolNameOf } from '../src/install/notify.js'
import { MessageStore } from '../src/store/store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-taint-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const peer = (over: Partial<TaintSource> = {}): TaintSource => ({
  direction: 'in',
  authority: 'peer',
  grant: 'read',
  senderLabel: 'alice',
  channelId: 'c0ffee',
  ...over,
})

describe('오염 상태', () => {
  test('처음에는 없다', async () => {
    expect(await readTaint(dir)).toBeUndefined()
  })

  test('내가 보낸 것은 오염이 아니다 — 내 코덱스가 내 클로드에 시키는 경로다', async () => {
    await addTaint(dir, [{ direction: 'in', authority: 'self', grant: 'execute' }])
    await addTaint(dir, [{ direction: 'out' }])
    expect(await readTaint(dir)).toBeUndefined()
  })

  test('동료 한 건이 들어오면 그 권한으로 찍힌다', async () => {
    const t = await addTaint(dir, [peer()])
    expect(t).toMatchObject({ grant: 'read', from: 'alice', channelId: 'c0ffee', count: 1 })
  })

  test('겹치면 좁아지고, 이름은 지금 남은 권한을 만든 쪽을 가리킨다', async () => {
    await addTaint(dir, [peer({ senderLabel: 'bob', grant: 'write' })])
    const t = await addTaint(dir, [peer({ senderLabel: 'alice', grant: 'read' })])
    expect(t).toMatchObject({ grant: 'read', from: 'alice', count: 2 })
  })

  test('더 넓은 것이 나중에 와도 넓어지지 않는다', async () => {
    await addTaint(dir, [peer({ grant: 'read' })])
    const t = await addTaint(dir, [peer({ senderLabel: 'bob', grant: 'execute' })])
    expect(t).toMatchObject({ grant: 'read', from: 'alice' })
  })

  test('상태 파일은 0600 이다 — 누구의 말이 언제 왔는지도 정보다', async () => {
    await addTaint(dir, [peer()])
    expect((await stat(taintPathOf(dir))).mode & 0o777).toBe(0o600)
  })

  test('푸는 것은 clearTaint 뿐이다', async () => {
    await addTaint(dir, [peer()])
    await clearTaint(dir)
    expect(await readTaint(dir)).toBeUndefined()
  })

  test('깨진 파일은 없음이 아니라 예외다 — 아니면 파일 하나로 강제가 풀린다', async () => {
    await writeFile(taintPathOf(dir), '{ 아무거나')
    await expect(readTaint(dir)).rejects.toThrow()

    await writeFile(taintPathOf(dir), JSON.stringify({ version: 99, taint: { grant: 'read' } }))
    await expect(readTaint(dir)).rejects.toThrow('버전')

    await writeFile(
      taintPathOf(dir),
      JSON.stringify({ version: TAINT_VERSION, taint: { grant: 'root', since: 1, count: 1 } }),
    )
    await expect(readTaint(dir)).rejects.toThrow('grant')
  })

  test('깨진 파일도 사용자 입력이면 치운다 — 아니면 세션이 영구히 막힌다', async () => {
    await writeFile(taintPathOf(dir), 'not json')
    await clearTaint(dir)
    expect(await readTaint(dir)).toBeUndefined()
  })
})

describe('판정', () => {
  const t = { grant: 'read' as const, since: 0, from: 'alice', channelId: 'c0ffee', count: 1 }

  test('오염이 없으면 전부 통과다', () => {
    expect(verdict(undefined, 'Bash').deny).toBe(false)
  })

  test('읽기 오염은 읽기 툴을 막지 않는다', () => {
    expect(verdict(t, 'Read').deny).toBe(false)
  })

  test('읽기 오염은 쓰기·실행을 막는다', () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'WebFetch']) {
      expect(verdict(t, tool).deny).toBe(true)
    }
  })

  test('막아도 동료에게 답은 된다', () => {
    expect(verdict(t, 'mcp__agent-channel-mesh__send').deny).toBe(false)
  })

  test('write 를 준 동료는 편집까지 되고 명령은 안 된다', () => {
    const w = { ...t, grant: 'write' as const }
    expect(verdict(w, 'Edit').deny).toBe(false)
    expect(verdict(w, 'Bash').deny).toBe(true)
  })

  test('이유는 비면 안 되고, 푸는 방법이 들어 있어야 한다', () => {
    // Codex 는 이유 없는 deny 를 오류로 보고 판정을 버린다. 그리고 이유가
    // 안 보이면 모델이 막힌 줄만 알고 다른 길을 찾아 헤맨다.
    const v = verdict(t, 'Bash')
    expect(v.reason).toContain('alice')
    expect(v.reason).toContain('Bash')
    expect(v.reason).toContain('사용자')
  })
})

describe('툴 이름 읽기', () => {
  test('두 에이전트가 주는 snake_case 를 먼저 본다', () => {
    expect(toolNameOf(JSON.stringify({ tool_name: 'Bash' }))).toBe('Bash')
    expect(toolNameOf(JSON.stringify({ toolName: 'Bash' }))).toBe('Bash')
  })

  test('못 읽으면 undefined — 그러면 오염 중에는 거부다', () => {
    expect(toolNameOf('아님')).toBeUndefined()
    expect(toolNameOf('[]')).toBeUndefined()
    expect(toolNameOf(JSON.stringify({ tool_name: '  ' }))).toBeUndefined()
  })
})

describe('게이트', () => {
  const store = () => new MessageStore({ dir })
  const payload = (tool: string) => () => Promise.resolve(JSON.stringify({ tool_name: tool }))

  test('오염이 없으면 페이로드를 읽지도 않는다', async () => {
    let read = 0
    const out = await runGate(store(), () => {
      read++
      return Promise.resolve('{}')
    })
    expect(out.hookSpecificOutput).toBeUndefined()
    expect(read).toBe(0)
  })

  test('오염 중에 실행 툴을 부르면 deny 가 실린다', async () => {
    await addTaint(dir, [peer()])
    const out = await runGate(store(), payload('Bash'))
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBeTruthy()
    // Codex 0.147 은 이 필드를 만나면 판정을 통째로 버린다.
    expect(out.continue).toBe(true)
  })

  test('오염 중에도 읽기 툴은 판정을 싣지 않는다', async () => {
    await addTaint(dir, [peer()])
    expect((await runGate(store(), payload('Read'))).hookSpecificOutput).toBeUndefined()
  })

  test('무엇을 부르는지 못 읽으면 막는다', async () => {
    await addTaint(dir, [peer()])
    const out = await runGate(store(), () => Promise.resolve(undefined))
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  test('상태 파일이 깨져 있으면 막는다 — 망가뜨리는 것이 우회가 되면 안 된다', async () => {
    await writeFile(taintPathOf(dir), 'not json')
    const out = await runGate(store(), payload('Read'))
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
  })
})
