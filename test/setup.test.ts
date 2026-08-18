/**
 * 설정이 없을 때의 첫 실행.
 *
 * 여기서 지키는 것은 "설정이 없으면 **말을 한다**"이다. 그 반대 —
 * 조용히 죽는 것 — 이 기본값이었고, 그 상태는 깐 사람 쪽에서 툴이 아예
 * 없는 것으로만 보인다.
 */
import { test, expect, describe, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSetup, SETUP_TOOL, SETUP_INSTRUCTIONS } from '../src/adapter/setup.js'
import { SETUP_HINT } from '../src/install/notify.js'

const dirs: string[] = []

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acm-setup-'))
  dirs.push(dir)
  return join(dir, 'config.json')
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('setup 툴', () => {
  test('설정을 0600 으로 만든다', async () => {
    // 이 파일 하나면 과거·미래 메시지를 전부 읽을 수 있다(§11).
    const path = await tempConfigPath()
    const result = await runSetup({ configPath: path }, { relay: 'https://relay.example' })

    expect(result.isError).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('릴레이를 설정에 옮겨 적는다', async () => {
    const path = await tempConfigPath()
    await runSetup({ configPath: path }, { relay: 'https://relay.example' })

    const config = JSON.parse(await readFile(path, 'utf8')) as { relay?: string; channels: [] }
    expect(config.relay).toBe('https://relay.example')
    // 채널은 비어 있다 — 상대 공개키 없이는 만들 수 없다.
    expect(config.channels).toEqual([])
  })

  test('시드를 돌려주지 않는다', async () => {
    // 돌려주면 모델 컨텍스트에 개인키가 들어가고, 그 컨텍스트는 로그·요약·
    // 전송을 거친다. 밖으로 나가는 값은 공개키와 지문뿐이어야 한다(§9).
    const path = await tempConfigPath()
    const result = await runSetup({ configPath: path }, { relay: 'https://relay.example' })

    const { seed } = JSON.parse(await readFile(path, 'utf8')) as { seed: string }
    expect(seed).toHaveLength(64)
    expect(result.text).not.toContain(seed)
  })

  test('상대에게 보낼 값과 지문을 함께 낸다', async () => {
    const path = await tempConfigPath()
    const result = await runSetup({ configPath: path }, { relay: 'https://r.example', label: 'alice' })

    expect(result.text).toContain('members')
    expect(result.text).toContain('alice')
    // 지문은 대역 외 대조용이라, 안내가 같이 붙어 있어야 의미가 있다(§9).
    expect(result.text).toContain('지문')
  })

  test('이미 있으면 덮어쓰지 않고 오류로 알린다', async () => {
    // 성공이라고 하면 모델이 새 신원이 생겼다고 믿고 상대에게 옛 지문을
    // 보낸다. 덮어쓰기는 신원 소실이라 되돌릴 방법이 없다.
    const path = await tempConfigPath()
    await runSetup({ configPath: path }, { relay: 'https://r.example' })
    const first = await readFile(path, 'utf8')

    const again = await runSetup({ configPath: path }, { relay: 'https://other.example' })

    expect(again.isError).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(first)
  })

  test('릴레이 토큰은 인자가 아니라 환경에서 온다', async () => {
    // 플래그로 받으면 `ps` 에 그대로 찍힌다(§10.13).
    expect(JSON.stringify(SETUP_TOOL.inputSchema)).not.toContain('token')

    const path = await tempConfigPath()
    await runSetup({ configPath: path, relayToken: 'tok' }, { relay: 'https://r.example' })
    expect(JSON.parse(await readFile(path, 'utf8')) as { relayToken?: string }).toMatchObject({
      relayToken: 'tok',
    })
  })
})

describe('첫 실행 안내', () => {
  test('릴레이 URL 을 추측하지 말라고 못 박는다', () => {
    // 틀린 릴레이는 설정이 멀쩡히 만들어지고 메시지만 영원히 안 간다.
    expect(SETUP_INSTRUCTIONS).toContain('Do not guess')
  })

  test('세션을 다시 열라고 알린다', () => {
    // 설정이 생겨도 이미 뜬 서버는 설정 모드 그대로다.
    expect(SETUP_INSTRUCTIONS).toContain('restart')
  })

  test('훅 안내가 setup 툴을 가리킨다', () => {
    // 플러그인 설치 경로는 에이전트·마켓플레이스·버전에 따라 갈리는 캐시
    // 경로라, 사람에게 받아 적으라고 할 수 있는 명령이 아니다.
    expect(SETUP_HINT).toContain('setup tool')
  })
})

describe('설정 없는 훅 — 실제로 돌려 본다', () => {
  async function runHookProcess(event: string): Promise<{ code: number; stdout: string }> {
    const missing = join(await tempConfigPath(), 'nope', 'config.json')
    const proc = Bun.spawn(
      ['bun', 'src/adapter/bin.ts', 'hook', '--event', event, '--config', missing],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = await new Response(proc.stdout).text()
    return { code: await proc.exited, stdout }
  }

  test('SessionStart 에 안내를 싣는다', async () => {
    const { code, stdout } = await runHookProcess('SessionStart')
    expect(code).toBe(0)
    expect(JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext: string } }).toMatchObject(
      { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SETUP_HINT } },
    )
  }, 20_000)

  test('PostToolUse 에는 싣지 않는다', async () => {
    // 툴 호출마다 도는 훅이다. 여기서 말하면 안내가 아니라 소음이다.
    const { code, stdout } = await runHookProcess('PostToolUse')
    expect(code).toBe(0)
    expect(JSON.parse(stdout) as Record<string, unknown>).toEqual({
      continue: true,
      suppressOutput: true,
    })
  }, 20_000)
})
