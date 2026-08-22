/**
 * 설정 변경 툴 테스트
 *
 * 여기서 지키는 것은 `configure.ts` 머리말의 세 방어다 — 권한이 600 밖으로
 * 나가지 않는 것, 검증에 걸린 변경이 파일을 건드리지 않는 것, 오염된 턴에서
 * 아무것도 바뀌지 않는 것.
 *
 * 디스크를 **직접** 읽어 확인한다. 툴이 돌려준 문구만 보면 "바꿨다고 말하고
 * 안 바꾸는" 구현도, "반쯤 쓰고 죽는" 구현도 전부 통과한다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIGURE_TOOLS,
  isConfigureTool,
  runConfigure,
  type ConfigureContext,
} from '../src/adapter/configure.js'
import { identityOf, validate } from '../src/adapter/config.js'
import { toKey } from '../src/identity/fingerprint.js'
import { addTaint, taintPathOf, type TaintSource } from '../src/policy/taint.js'
import { lockPathOf, withLock } from '../src/store/lock.js'

const SEED = '11'.repeat(32)
const SECRET = 'aa'.repeat(32)
const OTHER_SECRET = 'bb'.repeat(32)
const ALICE_SIGN = '01'.repeat(32)
const ALICE_KEM = '02'.repeat(32)
const BOB_SIGN = '03'.repeat(32)
const BOB_KEM = '04'.repeat(32)
const FP = 'ab'.repeat(16)
const FP2 = 'cd'.repeat(16)
const OTHER_SEED = '22'.repeat(32)

let dir: string
let configPath: string

/** 어댑터가 실제로 읽는 모양. `validate` 를 통과하는 최소 설정이다. */
function base(): Record<string, unknown> {
  return {
    seed: SEED,
    relay: 'https://relay.example',
    channels: [
      {
        name: 'team',
        secret: SECRET,
        axis: 'external',
        members: [{ label: 'alice', sign: ALICE_SIGN, kem: ALICE_KEM }],
      },
    ],
  }
}

async function writeConfig(raw: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  await chmod(configPath, 0o600)
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
}

function channels(raw: Record<string, unknown>): Record<string, unknown>[] {
  return raw.channels as Record<string, unknown>[]
}

function members(raw: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const found = channels(raw).find(c => c.name === name)
  return (found?.members ?? []) as Record<string, unknown>[]
}

function ctx(extra?: Partial<ConfigureContext>): ConfigureContext {
  return { configPath, ...extra }
}

async function fingerprintOf(seed = SEED): Promise<string> {
  return toKey((await identityOf(validate({ ...base(), seed }))).fingerprint)
}

async function waitForLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  throw new Error(`잠금 파일이 생기지 않았다: ${path}`)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-configure-'))
  configPath = join(dir, 'config.json')
  await writeConfig(base())
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('라우팅', () => {
  test('설정 툴 이름만 참이다', () => {
    for (const tool of CONFIGURE_TOOLS) expect(isConfigureTool(tool.name)).toBe(true)
    for (const name of ['send', 'inbox', 'channels', 'whoami', 'setup']) {
      expect(isConfigureTool(name)).toBe(false)
    }
  })

  test('모르는 이름은 조용히 성공하지 않는다', async () => {
    const r = await runConfigure(ctx(), 'channel_nuke', {})
    expect(r.isError).toBe(true)
  })
})

describe('channel_join', () => {
  test('없던 채널을 넣는다', async () => {
    const r = await runConfigure(ctx(), 'channel_join', {
      name: 'ops',
      secret: OTHER_SECRET,
      axis: 'internal',
      members: [{ label: 'bob', sign: BOB_SIGN, kem: BOB_KEM }],
    })
    expect(r.isError).toBeUndefined()

    const raw = await readConfig()
    expect(channels(raw)).toHaveLength(2)
    const ops = channels(raw).find(c => c.name === 'ops')!
    expect(ops.secret).toBe(OTHER_SECRET)
    expect(ops.axis).toBe('internal')
    expect(members(raw, 'ops')).toHaveLength(1)
  })

  test('없는 채널을 secret 없이 만들지 않는다', async () => {
    const before = await readFile(configPath, 'utf8')
    const r = await runConfigure(ctx(), 'channel_join', { name: 'ops' })
    expect(r.isError).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('같은 이름은 덮어쓰지 않고 합친다 — secret 을 빼면 그대로 둔다', async () => {
    const r = await runConfigure(ctx(), 'channel_join', {
      name: 'team',
      members: [{ label: 'bob', sign: BOB_SIGN, kem: BOB_KEM }],
    })
    expect(r.isError).toBeUndefined()

    const raw = await readConfig()
    expect(channels(raw)).toHaveLength(1)
    expect(channels(raw)[0]!.secret).toBe(SECRET)
    expect(members(raw, 'team').map(m => m.label)).toEqual(['alice', 'bob'])
  })

  test('같은 서명키는 두 사람이 되지 않고 갈아 끼워진다', async () => {
    await runConfigure(ctx(), 'channel_join', {
      name: 'team',
      members: [{ label: 'alice-laptop', sign: ALICE_SIGN, kem: ALICE_KEM }],
    })

    const list = members(await readConfig(), 'team')
    expect(list).toHaveLength(1)
    expect(list[0]!.label).toBe('alice-laptop')
  })

  test('hex 표기를 펴서 저장한다 — 표기가 갈리면 한 사람이 둘로 남는다', async () => {
    await runConfigure(ctx(), 'channel_join', {
      name: 'team',
      members: [{ label: 'alice2', sign: ALICE_SIGN.toUpperCase(), kem: ` ${ALICE_KEM} ` }],
    })

    const list = members(await readConfig(), 'team')
    expect(list).toHaveLength(1)
    expect(list[0]!.sign).toBe(ALICE_SIGN)
    expect(list[0]!.kem).toBe(ALICE_KEM)
  })

  test('길이가 어긋난 키는 들어가지 않는다', async () => {
    const before = await readFile(configPath, 'utf8')
    const r = await runConfigure(ctx(), 'channel_join', {
      name: 'team',
      members: [{ sign: 'ab', kem: BOB_KEM }],
    })
    expect(r.isError).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('검증에 걸린 변경은 파일을 건드리지 않는다', async () => {
    const before = await readFile(configPath, 'utf8')
    const r = await runConfigure(ctx(), 'channel_join', { name: 'team', axis: 'internel' })
    expect(r.isError).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('모르는 필드를 지우지 않는다', async () => {
    await writeConfig({ ...base(), store: { dir: join(dir, 'store') } })
    await runConfigure(ctx(), 'channel_join', {
      name: 'team',
      members: [{ label: 'bob', sign: BOB_SIGN, kem: BOB_KEM }],
    })
    expect((await readConfig()).store).toEqual({ dir: join(dir, 'store') })
  })
})

describe('channel_leave', () => {
  test('채널을 지운다', async () => {
    const r = await runConfigure(ctx(), 'channel_leave', { name: 'team' })
    expect(r.isError).toBeUndefined()
    expect(channels(await readConfig())).toHaveLength(0)
  })

  test('없는 채널은 성공으로 보고하지 않는다', async () => {
    const r = await runConfigure(ctx(), 'channel_leave', { name: 'ops' })
    expect(r.isError).toBe(true)
    expect(channels(await readConfig())).toHaveLength(1)
  })
})

describe('member_remove', () => {
  beforeEach(async () => {
    await runConfigure(ctx(), 'channel_join', {
      name: 'team',
      members: [{ label: 'bob', sign: BOB_SIGN, kem: BOB_KEM }],
    })
  })

  test('label 로 뺀다', async () => {
    const r = await runConfigure(ctx(), 'member_remove', { channel: 'team', label: 'alice' })
    expect(r.isError).toBeUndefined()
    expect(members(await readConfig(), 'team').map(m => m.label)).toEqual(['bob'])
  })

  test('sign 으로 뺀다 — 대문자로 줘도 같은 사람이다', async () => {
    const r = await runConfigure(ctx(), 'member_remove', {
      channel: 'team',
      sign: BOB_SIGN.toUpperCase(),
    })
    expect(r.isError).toBeUndefined()
    expect(members(await readConfig(), 'team').map(m => m.label)).toEqual(['alice'])
  })

  test('지목이 없으면 아무도 빠지지 않는다', async () => {
    const r = await runConfigure(ctx(), 'member_remove', { channel: 'team' })
    expect(r.isError).toBe(true)
    expect(members(await readConfig(), 'team')).toHaveLength(2)
  })

  test('없는 멤버는 성공으로 보고하지 않는다', async () => {
    const r = await runConfigure(ctx(), 'member_remove', { channel: 'team', label: 'carol' })
    expect(r.isError).toBe(true)
    expect(members(await readConfig(), 'team')).toHaveLength(2)
  })
})

describe('trust_agent · untrust_agent', () => {
  test('지문을 self 에 넣는다', async () => {
    const r = await runConfigure(ctx(), 'trust_agent', { fingerprint: FP })
    expect(r.isError).toBeUndefined()
    expect((await readConfig()).self).toEqual([FP])
  })

  test('표기가 달라도 같은 지문은 두 번 들어가지 않는다', async () => {
    await runConfigure(ctx(), 'trust_agent', { fingerprint: FP })
    const r = await runConfigure(ctx(), 'trust_agent', { fingerprint: FP.toUpperCase() })
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('이미 self 에 있다')
    expect((await readConfig()).self).toEqual([FP])
  })

  test('지문이 아닌 값은 self 에 닿지 못한다', async () => {
    const r = await runConfigure(ctx(), 'trust_agent', { fingerprint: 'not-a-fingerprint' })
    expect(r.isError).toBe(true)
    expect((await readConfig()).self).toBeUndefined()
  })

  test('self 에서 뺀다', async () => {
    await runConfigure(ctx(), 'trust_agent', { fingerprint: FP })
    await runConfigure(ctx(), 'trust_agent', { fingerprint: FP2 })

    const r = await runConfigure(ctx(), 'untrust_agent', { fingerprint: FP })
    expect(r.isError).toBeUndefined()
    expect((await readConfig()).self).toEqual([FP2])
  })

  test('없는 지문을 뺐다고 말하지 않는다', async () => {
    const r = await runConfigure(ctx(), 'untrust_agent', { fingerprint: FP })
    expect(r.isError).toBe(true)
  })
})

describe('peer_grant', () => {
  test('등급을 정한다', async () => {
    const r = await runConfigure(ctx(), 'peer_grant', { fingerprint: FP, grant: 'write' })
    expect(r.isError).toBeUndefined()
    expect((await readConfig()).policy).toEqual({ peers: { [FP]: 'write' } })
  })

  test('없는 등급은 정책에 닿지 못한다', async () => {
    const r = await runConfigure(ctx(), 'peer_grant', { fingerprint: FP, grant: 'admin' })
    expect(r.isError).toBe(true)
    expect((await readConfig()).policy).toBeUndefined()
  })

  test('none 이면 정책에서 뺀다 — 기본값으로 돌아간다', async () => {
    await runConfigure(ctx(), 'peer_grant', { fingerprint: FP, grant: 'execute' })
    await runConfigure(ctx(), 'peer_grant', { fingerprint: FP2, grant: 'write' })

    const r = await runConfigure(ctx(), 'peer_grant', { fingerprint: FP, grant: 'none' })
    expect(r.isError).toBeUndefined()
    expect((await readConfig()).policy).toEqual({ peers: { [FP2]: 'write' } })
  })

  test('정책에 없는 지문을 뺐다고 말하지 않는다', async () => {
    const r = await runConfigure(ctx(), 'peer_grant', { fingerprint: FP, grant: 'none' })
    expect(r.isError).toBe(true)
  })

  test('policy.default 를 건드리지 않는다', async () => {
    await writeConfig({ ...base(), policy: { default: 'read', peers: {} } })
    await runConfigure(ctx(), 'peer_grant', { fingerprint: FP, grant: 'write' })
    expect((await readConfig()).policy).toEqual({ default: 'read', peers: { [FP]: 'write' } })
  })
})

describe('relay_set', () => {
  test('주소를 바꾼다', async () => {
    const r = await runConfigure(ctx(), 'relay_set', { url: 'https://other.example' })
    expect(r.isError).toBeUndefined()
    expect((await readConfig()).relay).toBe('https://other.example')
  })

  test('토큰을 응답에 싣지 않는다 — 실으면 대화 기록에 그대로 남는다', async () => {
    const token = 'super-secret-relay-token'
    const r = await runConfigure(ctx(), 'relay_set', { url: 'https://other.example', token })
    expect(r.text).not.toContain(token)
    expect((await readConfig()).relayToken).toBe(token)
  })

  test('토큰을 빼면 두던 값을 둔다', async () => {
    await writeConfig({ ...base(), relayToken: 'keep-me' })
    await runConfigure(ctx(), 'relay_set', { url: 'https://other.example' })
    expect((await readConfig()).relayToken).toBe('keep-me')
  })
})

describe('파일 권한', () => {
  test('바꾼 뒤에도 600 이다', async () => {
    await runConfigure(ctx(), 'channel_leave', { name: 'team' })
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  test('umask 가 넓어도 600 이다', async () => {
    const before = process.umask(0o000)
    try {
      await runConfigure(ctx(), 'channel_leave', { name: 'team' })
    } finally {
      process.umask(before)
    }
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })
})

describe('런타임 신원 경계와 RMW 잠금', () => {
  test('runtime fingerprint와 파일 seed가 일치하면 쓴다', async () => {
    const runtimeFingerprint = await fingerprintOf()
    const r = await runConfigure(ctx({ runtimeFingerprint }), 'channel_leave', { name: 'team' })

    expect(r.isError).toBeUndefined()
    expect(channels(await readConfig())).toHaveLength(0)
  })

  test('파일이 다른 seed로 교체되면 runtime/file fingerprint를 함께 보고 거부한다', async () => {
    const runtimeFingerprint = await fingerprintOf(OTHER_SEED)
    const fileFingerprint = await fingerprintOf()
    const before = await readFile(configPath, 'utf8')

    const r = await runConfigure(ctx({ runtimeFingerprint }), 'channel_leave', { name: 'team' })

    expect(r.isError).toBe(true)
    expect(r.text).toContain(`runtime fingerprint=${runtimeFingerprint}`)
    expect(r.text).toContain(`file fingerprint=${fileFingerprint}`)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('read-modify-write 전체가 설정 파일 잠금 경로에서 직렬화된다', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const lockPath = lockPathOf(configPath)
    const holder = withLock(configPath, async () => held)
    await waitForLock(lockPath)

    let finished = false
    const mutation = runConfigure(ctx(), 'channel_leave', { name: 'team' }).then(result => {
      finished = true
      return result
    })

    await new Promise(resolve => setTimeout(resolve, 25))
    expect(finished).toBe(false)

    release()
    await holder
    const result = await mutation
    expect(result.isError).toBeUndefined()

    let lockRemains = true
    try {
      await stat(lockPath)
    } catch {
      lockRemains = false
    }
    expect(lockRemains).toBe(false)
  })
})

describe('오염된 턴', () => {
  const peer: TaintSource = {
    direction: 'in',
    authority: 'peer',
    grant: 'execute',
    senderLabel: 'mallory',
  }

  test('동료의 말이 들어와 있으면 아무것도 바꾸지 않는다', async () => {
    await addTaint(dir, [peer])
    const before = await readFile(configPath, 'utf8')

    for (const tool of CONFIGURE_TOOLS) {
      const r = await runConfigure(ctx({ taintDir: dir }), tool.name, {
        name: 'team',
        channel: 'team',
        label: 'alice',
        fingerprint: FP,
        grant: 'execute',
        url: 'https://attacker.example',
        secret: OTHER_SECRET,
      })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('mallory')
    }
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('오염을 읽지 못하면 막는다 — 모르는 것은 통과가 아니다', async () => {
    await writeFile(taintPathOf(dir), '{ 이건 JSON 이 아니다', { mode: 0o600 })
    const before = await readFile(configPath, 'utf8')

    const r = await runConfigure(ctx({ taintDir: dir }), 'trust_agent', { fingerprint: FP })
    expect(r.isError).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })

  test('오염이 없으면 통과한다', async () => {
    const r = await runConfigure(ctx({ taintDir: dir }), 'trust_agent', { fingerprint: FP })
    expect(r.isError).toBeUndefined()
    expect((await readConfig()).self).toEqual([FP])
  })

  test('내가 보낸 말은 오염이 아니다', async () => {
    await addTaint(dir, [{ direction: 'in', authority: 'self' }])
    const r = await runConfigure(ctx({ taintDir: dir }), 'trust_agent', { fingerprint: FP })
    expect(r.isError).toBeUndefined()
  })
})
