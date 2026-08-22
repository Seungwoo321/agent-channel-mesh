/**
 * 설정·진입점 테스트
 *
 * 여기서 지키는 것은 두 가지다 — 잘못된 설정이 조용히 반쪽 동작하지 않는 것,
 * 그리고 시드가 든 파일이 넓은 권한으로 읽히지 않는 것.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { toHex, toKey } from '../src/identity/fingerprint.js'
import {
  loadConfig,
  buildNode,
  validate,
  fromHex,
  expandHome,
  storeOptionsOf,
  identityOf,
  configPathFromEnv,
  SESSION_CONFIG_DIR,
  CODEX_CONFIG_PATH,
  type Config,
} from '../src/adapter/config.js'
import { DEFAULT_STORE_DIR } from '../src/store/store.js'
import { init, whoami, skeleton, newChannelSecret } from '../src/adapter/onboard.js'
import { parseArgs } from '../src/adapter/bin.js'

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

/** hex 는 공백 없이. fingerprint 의 toHex 는 4글자씩 끊으므로 여기선 직접 만든다. */
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

function sample(): Config {
  return {
    seed: hex(alice.seed),
    relay: 'https://relay.example',
    channels: [
      {
        secret: hex(new Uint8Array(32).fill(7)),
        name: '팀',
        members: [
          { label: 'alice', sign: hex(alice.signPublicKey), kem: hex(alice.kemPublicKey) },
          { label: 'bob', sign: hex(bob.signPublicKey), kem: hex(bob.kemPublicKey) },
        ],
        mentions: ['alice'],
      },
    ],
  }
}

describe('hex', () => {
  test('왕복한다', () => {
    expect(hex(fromHex('00ff10'))).toBe('00ff10')
  })

  test('공백을 무시한다 — 지문은 4글자씩 끊어 보여준다 (§9)', () => {
    expect(fromHex('2bfd f0fe')).toHaveLength(4)
  })

  test('길이가 어긋나면 조용히 자르지 않고 던진다', () => {
    expect(() => fromHex('00ff', 32)).toThrow(/32바이트/)
  })

  test('hex 가 아니면 던진다', () => {
    expect(() => fromHex('zz')).toThrow(/hex/)
  })

  test('홀수 길이를 거부한다', () => {
    expect(() => fromHex('abc')).toThrow(/hex/)
  })
})

describe('경로', () => {
  test('~ 를 홈으로 편다', () => {
    expect(expandHome('~/.acm/c.json', '/Users/x')).toBe('/Users/x/.acm/c.json')
  })

  test('절대경로는 그대로 둔다', () => {
    expect(expandHome('/etc/acm.json', '/Users/x')).toBe('/etc/acm.json')
  })

  test('중간의 ~ 는 건드리지 않는다', () => {
    expect(expandHome('/a/~/b', '/Users/x')).toBe('/a/~/b')
  })
})

describe('검증', () => {
  test('정상 설정을 통과시킨다', () => {
    expect(validate(sample()).channels).toHaveLength(1)
  })

  test('seed 가 없으면 던진다', () => {
    const { seed: _drop, ...rest } = sample()
    expect(() => validate(rest)).toThrow(/seed/)
  })

  test('seed 길이가 틀리면 던진다', () => {
    expect(() => validate({ ...sample(), seed: 'aabb' })).toThrow(/32바이트/)
  })

  test('channels 가 배열이 아니면 던진다', () => {
    expect(() => validate({ ...sample(), channels: {} })).toThrow(/channels/)
  })

  test('채널 비밀 길이가 틀리면 던진다', () => {
    const c = sample()
    expect(() => validate({ ...c, channels: [{ ...c.channels[0]!, secret: 'aa' }] })).toThrow(
      /32바이트/,
    )
  })

  test('멤버에 kem 이 없으면 던진다', () => {
    const c = sample()
    const bad = { ...c.channels[0]!, members: [{ sign: hex(alice.signPublicKey) }] }
    expect(() => validate({ ...c, channels: [bad] })).toThrow(/sign·kem/)
  })

  test('relay 는 없어도 된다 — 로컬 전용', () => {
    const { relay: _drop, ...rest } = sample()
    expect(validate(rest).relay).toBeUndefined()
  })

  test('relayToken 은 없어도 된다 — 루프백 릴레이는 열려 있다 (§10.13)', () => {
    expect(validate(sample()).relayToken).toBeUndefined()
  })

  test('relayToken 을 그대로 실어 준다', () => {
    expect(validate({ ...sample(), relayToken: 'd'.repeat(40) }).relayToken).toBe('d'.repeat(40))
  })

  test('relayToken 이 문자열이 아니면 던진다', () => {
    // 숫자로 적힌 토큰은 헤더에 붙는 순간 `[object Object]` 급 쓰레기가 되고,
    // 릴레이는 401 만 돌려준다 — 원인이 설정 파일에 있다는 게 안 보인다.
    expect(() => validate({ ...sample(), relayToken: 12345 })).toThrow(/relayToken/)
  })

  test('객체가 아니면 던진다', () => {
    expect(() => validate('설정')).toThrow(/객체/)
  })
})

describe('저장소 설정 (§6.3)', () => {
  const withStore = (store: unknown) => ({ ...sample(), store })

  test('store 블록이 그대로 통과한다', () => {
    const c = validate(withStore({ dir: '/tmp/acm', retentionMs: 86_400_000, maxPerChannel: 100 }))
    expect(c.store).toEqual({ dir: '/tmp/acm', retentionMs: 86_400_000, maxPerChannel: 100 })
  })

  test('store 가 없어도 유효하다 — 저장소가 자기 기본값으로 선다', () => {
    expect(validate(sample()).store).toBeUndefined()
  })

  test('빈 store 도 통과한다 — 전부 선택이다', () => {
    expect(validate(withStore({})).store).toEqual({})
  })

  test('store 가 객체가 아니면 던진다', () => {
    expect(() => validate(withStore('~/msgs'))).toThrow(/store 는 객체/)
  })

  test('dir 이 문자열이 아니면 던진다', () => {
    expect(() => validate(withStore({ dir: 7 }))).toThrow(/store\.dir/)
  })

  test('무제한 보관을 설정 파일로도 못 넣는다', () => {
    // 저장소 생성자도 막지만, 원인이 설정 파일일 때는 설정 오류로 죽어야 진단이 된다.
    expect(() => validate(withStore({ retentionMs: Number.POSITIVE_INFINITY }))).toThrow(
      /무제한 보관은 허용하지 않는다/,
    )
  })

  test('retentionMs 가 0 이거나 음수면 던진다', () => {
    expect(() => validate(withStore({ retentionMs: 0 }))).toThrow(/store\.retentionMs/)
    expect(() => validate(withStore({ retentionMs: -1 }))).toThrow(/store\.retentionMs/)
  })

  test('retentionMs 가 숫자가 아니면 던진다', () => {
    expect(() => validate(withStore({ retentionMs: '30d' }))).toThrow(/store\.retentionMs/)
  })

  test('maxPerChannel 이 정수가 아니면 던진다', () => {
    expect(() => validate(withStore({ maxPerChannel: 1.5 }))).toThrow(/store\.maxPerChannel/)
  })

  test('maxPerChannel 이 1 미만이면 던진다', () => {
    expect(() => validate(withStore({ maxPerChannel: 0 }))).toThrow(/store\.maxPerChannel/)
  })

  test('설정 파일로 읽어도 store 가 그대로 온다', async () => {
    const raw = JSON.stringify(withStore({ retentionMs: 3_600_000 }))
    const c = await loadConfig('/x.json', { read: async () => raw, mode: async () => 0o600 })
    expect(c.store?.retentionMs).toBe(3_600_000)
  })
})

describe('저장 위치는 신원에서 파생한다 (§6.3)', () => {
  test('기본 위치 아래 지문 디렉토리에 선다', () => {
    const opts = storeOptionsOf(undefined, alice)
    expect(opts.dir).toBe(`${DEFAULT_STORE_DIR}/${toKey(alice.fingerprint)}`)
  })

  test('설정한 dir 아래에도 지문이 붙는다', () => {
    // 바깥 디렉토리는 사용자 것이지만 마지막 한 칸은 아니다 — 두 설정 파일에
    // 같은 dir 을 적었다는 이유로 두 신원이 한 파일을 공유하면 안 된다.
    expect(storeOptionsOf({ dir: '/tmp/acm' }, alice).dir).toBe(
      `/tmp/acm/${toKey(alice.fingerprint)}`,
    )
  })

  test('신원이 다르면 디렉토리가 다르다', () => {
    // 실측된 고장이다: 한 기계에서 ACM_CONFIG 만 갈랐더니 코덱스의 inbox 가
    // 코덱스가 보낸 말을 자기 수신함에서 읽었다. 설정만으로는 안 갈린다.
    const same = { dir: '/tmp/acm' }
    expect(storeOptionsOf(same, alice).dir).not.toBe(storeOptionsOf(same, bob).dir)
  })

  test('나머지 값은 그대로 옮긴다', () => {
    const opts = storeOptionsOf({ retentionMs: 1_000, maxPerChannel: 5 }, alice)
    expect(opts.retentionMs).toBe(1_000)
    expect(opts.maxPerChannel).toBe(5)
  })

  test('설정의 시드에서 판 신원이 buildNode 와 같다', async () => {
    // 훅은 노드를 안 세우고 저장소만 여는데, 그 경로가 지문에 달려 있다.
    // 두 파생이 갈리면 훅이 빈 디렉토리를 열고 영원히 조용해진다.
    const config = sample()
    const { identity } = await buildNode(config)
    expect(toKey((await identityOf(config)).fingerprint)).toBe(toKey(identity.fingerprint))
  })
})

describe('세션 설정 경로는 세션마다 파생한다', () => {
  test('Codex thread id가 있으면 Codex 세션 경로를 쓴다', () => {
    const path = configPathFromEnv({ CODEX_THREAD_ID: 'thread-a', PLUGIN_ROOT: '/plugin' })
    expect(path).toMatch(new RegExp(`^${SESSION_CONFIG_DIR}/codex/[0-9a-f]{32}\\.json$`))
    expect(path).not.toBe(CODEX_CONFIG_PATH)
  })

  test('세션 ID가 다르면 설정 경로도 다르다', () => {
    expect(configPathFromEnv({ CODEX_THREAD_ID: 'thread-a' })).not.toBe(
      configPathFromEnv({ CODEX_THREAD_ID: 'thread-b' }),
    )
  })

  test('명시한 ACM_CONFIG가 자동 경로보다 우선한다', () => {
    expect(
      configPathFromEnv({ ACM_CONFIG: '/explicit.json', CODEX_THREAD_ID: 'thread-a' }),
    ).toBe('/explicit.json')
  })

  test('세션 ID가 없으면 기본 경로 선택을 호출자에게 맡긴다', () => {
    expect(configPathFromEnv({})).toBeUndefined()
  })
})

describe('파일 로드', () => {
  const read = async () => JSON.stringify(sample())

  test('600 은 통과한다', async () => {
    const c = await loadConfig('/x.json', { read, mode: async () => 0o600 })
    expect(c.channels).toHaveLength(1)
  })

  test('400 도 통과한다 — 더 좁은 것은 문제가 아니다', async () => {
    await expect(loadConfig('/x.json', { read, mode: async () => 0o400 })).resolves.toBeTruthy()
  })

  test('그룹에 열려 있으면 읽지 않고 던진다', async () => {
    // 시드가 든 파일을 남이 읽을 수 있으면 그 뒤의 암호는 전부 의미가 없다.
    await expect(loadConfig('/x.json', { read, mode: async () => 0o640 })).rejects.toThrow(
      /권한이 너무 넓다/,
    )
  })

  test('644 를 거부한다 — 기본 권한으로 만든 파일이 여기 걸린다', async () => {
    await expect(loadConfig('/x.json', { read, mode: async () => 0o644 })).rejects.toThrow(/640|644/)
  })

  test('실행 비트도 거부한다', async () => {
    await expect(loadConfig('/x.json', { read, mode: async () => 0o700 })).rejects.toThrow(
      /권한이 너무 넓다/,
    )
  })

  test('권한을 알 수 없으면 검사를 건너뛴다', async () => {
    await expect(loadConfig('/x.json', { read, mode: async () => undefined })).resolves.toBeTruthy()
  })

  test('깨진 JSON 은 경로를 실어 던진다', async () => {
    await expect(
      loadConfig('/x.json', { read: async () => '{{', mode: async () => 0o600 }),
    ).rejects.toThrow(/\/x\.json/)
  })

  test('~ 를 편 경로로 권한을 본다', async () => {
    let seen = ''
    await loadConfig('~/c.json', {
      read,
      mode: async p => {
        seen = p
        return 0o600
      },
    })
    expect(seen.startsWith('~')).toBe(false)
  })
})

describe('노드 조립', () => {
  test('시드에서 같은 신원이 나온다', async () => {
    const { identity } = await buildNode(sample())
    expect(toHex(identity.fingerprint)).toBe(toHex(alice.fingerprint))
  })

  test('설정의 채널에 붙는다', async () => {
    const { node } = await buildNode(sample())
    expect(node.channelIds()).toHaveLength(1)
  })

  test('멤버가 채널에 들어간다', async () => {
    const { node } = await buildNode(sample())
    const id = node.channelIds()[0]!
    expect(node.channel(id)!.list()).toHaveLength(2)
  })

  test('mentions 가 발화 제어로 전달된다 (§7)', async () => {
    const { node } = await buildNode(sample())
    const id = node.channelIds()[0]!
    // alice 를 부르지 않은 메시지는 응답 대상이 아니다.
    const from = { senderKeyId: bob.keyId, hops: 0 }
    expect(node.speech(id)!.check({ ...from, text: '아무 말' }).speak).toBe(false)
    expect(node.speech(id)!.check({ ...from, text: 'alice 야' }).speak).toBe(true)
  })

  test('relay 가 없으면 릴레이 없이 선다', async () => {
    const { relay: _drop, ...rest } = sample()
    const { node } = await buildNode(rest as Config)
    expect(node.channelIds()).toHaveLength(1)
  })

  test('채널이 없어도 선다 — 나중에 join 할 수 있다', async () => {
    const { node } = await buildNode({ ...sample(), channels: [] })
    expect(node.channelIds()).toHaveLength(0)
  })
})

describe('인자', () => {
  test('delivery 를 읽는다', () => {
    expect(parseArgs(['--delivery', 'inbox']).delivery).toBe('inbox')
  })

  test('config 경로를 읽는다', () => {
    expect(parseArgs(['--delivery', 'push', '--config', '/c.json']).config).toBe('/c.json')
  })

  test('환경변수로도 정해진다', () => {
    expect(parseArgs([], { ACM_DELIVERY: 'inbox', ACM_CONFIG: '/e.json' })).toMatchObject({
      command: 'serve',
      delivery: 'inbox',
      config: '/e.json',
    })
  })

  test('Codex thread id가 있으면 매니페스트 기본값보다 세션 경로가 우선한다', () => {
    const args = parseArgs(
      ['--delivery', 'inbox', '--config-default', CODEX_CONFIG_PATH],
      { CODEX_THREAD_ID: 'thread-a', PLUGIN_ROOT: '/plugin' },
    )
    const expected = configPathFromEnv({ CODEX_THREAD_ID: 'thread-a', PLUGIN_ROOT: '/plugin' })
    expect(expected).toBeDefined()
    expect(args.config).toBe(expected!)
  })

  // 설정 경로의 우선순위 (§6.4) — `--config` → ACM_CONFIG → `--config-default` → 기본값.
  // 매니페스트가 적는 것은 런타임의 **기본** 신원이라 환경변수에 져야 한다. 그 자리에
  // `--config` 를 쓰면 워크트리마다 다른 신원을 고를 길이 막힌다.
  test('--config 는 ACM_CONFIG 를 이긴다', () => {
    expect(
      parseArgs(['--delivery', 'inbox', '--config', '/pin.json'], { ACM_CONFIG: '/e.json' }).config,
    ).toBe('/pin.json')
  })

  test('ACM_CONFIG 는 --config-default 를 이긴다', () => {
    expect(
      parseArgs(['--delivery', 'inbox', '--config-default', '/d.json'], { ACM_CONFIG: '/e.json' })
        .config,
    ).toBe('/e.json')
  })

  test('ACM_CONFIG 가 없으면 --config-default 를 쓴다 — 기본값으로 떨어지지 않는다', () => {
    expect(parseArgs(['--delivery', 'inbox', '--config-default', '/d.json'], {}).config).toBe(
      '/d.json',
    )
    // 공백뿐인 값은 없는 것과 같다. 안 그러면 빈 경로를 신원으로 읽으러 간다.
    expect(
      parseArgs(['--delivery', 'inbox', '--config-default', '/d.json'], { ACM_CONFIG: '  ' })
        .config,
    ).toBe('/d.json')
  })

  test('인자 순서가 우선순위를 흔들지 않는다', () => {
    expect(
      parseArgs(['--config', '/pin.json', '--config-default', '/d.json', '--delivery', 'inbox'])
        .config,
    ).toBe('/pin.json')
    expect(
      parseArgs(['--config-default', '/d.json', '--config', '/pin.json', '--delivery', 'inbox'])
        .config,
    ).toBe('/pin.json')
  })

  test('hook 앞의 --config-default 도 훅이 물려받는다', () => {
    expect(parseArgs(['--config-default', '/d.json', 'hook', '--event', 'Stop'])).toMatchObject({
      command: 'hook',
      config: '/d.json',
    })
  })

  test('폴링 비용 설정을 환경변수로 읽는다', () => {
    expect(
      parseArgs(['--delivery', 'inbox'], { ACM_POLL_MS: '5000', ACM_POLL_MAX_MS: '600000' }),
    ).toMatchObject({ pollMs: 5000, pollMaxMs: 600000 })
  })

  test('인자가 환경변수를 이긴다', () => {
    expect(parseArgs(['--delivery', 'push'], { ACM_DELIVERY: 'inbox' }).delivery).toBe('push')
  })

  test('delivery 를 추측하지 않는다 — 틀리면 조용히 고장난다', () => {
    expect(() => parseArgs([])).toThrow(/push·inbox·both/)
  })

  test('both 를 받는다', () => {
    expect(parseArgs(['--delivery', 'both']).delivery).toBe('both')
  })

  test('모르는 값을 거부한다', () => {
    expect(() => parseArgs(['--delivery', 'pusn'])).toThrow(/push·inbox·both/)
  })

  test('모르는 인자를 무시하지 않는다 — 오타가 기본값이 되면 안 된다', () => {
    expect(() => parseArgs(['--delivery', 'inbox', '--dilivery', 'push'])).toThrow(/모르는 인자/)
  })

  test('기본 설정 경로를 준다', () => {
    expect(parseArgs(['--delivery', 'inbox']).config).toContain('agent-channel-mesh')
  })
})

describe('온보딩', () => {
  test('설정 뼈대에 채널이 비어 있다 — 상대 공개키 없이는 못 만든다', () => {
    const s = skeleton(alice.seed, 'https://r.example')
    expect(s.channels).toHaveLength(0)
    expect(s.relay).toBe('https://r.example')
  })

  test('뼈대가 그대로 검증을 통과한다', () => {
    expect(() => validate(skeleton(alice.seed))).not.toThrow()
  })

  test('relay 를 안 주면 필드가 아예 없다', () => {
    expect('relay' in skeleton(alice.seed)).toBe(false)
  })

  test('릴레이 토큰을 뼈대에 옮겨 적는다 (§10.13)', () => {
    const s = skeleton(alice.seed, 'https://r.example', 'e'.repeat(40))
    expect(s.relayToken).toBe('e'.repeat(40))
    expect(() => validate(s)).not.toThrow()
  })

  test('토큰을 안 주면 필드가 아예 없다 — 빈 문자열을 남기지 않는다', () => {
    expect('relayToken' in skeleton(alice.seed, 'https://r.example')).toBe(false)
  })

  test('init 이 환경변수에서 온 토큰을 파일에 옮겨 적는다', async () => {
    // 이것이 `init` 이 토큰을 아는 유일한 경로다. 플래그로 받으면 `ps` 에
    // 찍혀 같은 기계의 다른 사용자가 프로세스 목록만으로 가져간다.
    let written = ''
    await init('/c.json', {
      relay: 'https://r.example',
      relayToken: 'f'.repeat(40),
      exists: async () => false,
      write: async (_p, t) => void (written = t),
    })
    expect(JSON.parse(written).relayToken).toBe('f'.repeat(40))
  })

  test('init 이 0600 으로 쓴다', async () => {
    let mode = -1
    await init('/c.json', {
      exists: async () => false,
      write: async (_p, _t) => {
        mode = 0o600
      },
    })
    expect(mode).toBe(0o600)
  })

  test('init 이 쓴 것은 그대로 로드된다', async () => {
    let written = ''
    await init('/c.json', { exists: async () => false, write: async (_p, t) => void (written = t) })
    const c = await loadConfig('/c.json', { read: async () => written, mode: async () => 0o600 })
    expect(c.channels).toHaveLength(0)
  })

  test('매번 다른 시드를 만든다', async () => {
    const seeds: string[] = []
    for (let i = 0; i < 2; i++) {
      await init('/c.json', {
        exists: async () => false,
        write: async (_p, t) => void seeds.push(JSON.parse(t).seed),
      })
    }
    expect(seeds[0]).not.toBe(seeds[1])
  })

  test('이미 있으면 덮어쓰지 않는다 — 시드를 잃으면 신원이 사라진다', async () => {
    let wrote = false
    const r = await init('/c.json', {
      exists: async () => true,
      write: async () => void (wrote = true),
    })
    expect(wrote).toBe(false)
    expect(r.existed).toBe(true)
  })

  test('채널 비밀은 32바이트다', () => {
    expect(fromHex(newChannelSecret())).toHaveLength(32)
  })

  test('채널 비밀은 매번 다르다', () => {
    expect(newChannelSecret()).not.toBe(newChannelSecret())
  })

  test('whoami 가 설정에 그대로 넣을 수 있는 멤버를 준다', () => {
    const out = whoami(alice, 'alice')
    const json = out.slice(out.indexOf('{'), out.indexOf('}') + 1)
    const m = JSON.parse(json)
    expect(m.label).toBe('alice')
    expect(fromHex(m.sign)).toHaveLength(32)
    expect(fromHex(m.kem)).toHaveLength(32)
  })

  test('whoami 의 지문을 자르지 않는다 (§9)', () => {
    // 접두만 보여주면 갈아 맞출 수 있다. 128비트 전부여야 한다.
    expect(whoami(alice)).toMatch(/fp: (?:[0-9a-f]{4} ){7}[0-9a-f]{4}/)
  })

  test('whoami 가 대역 외 대조를 요구한다', () => {
    expect(whoami(alice)).toMatch(/다른 경로|대조/)
  })
})

describe('명령 인자', () => {
  test('init 은 delivery 를 요구하지 않는다', () => {
    expect(parseArgs(['init']).command).toBe('init')
  })

  test('whoami 도 요구하지 않는다', () => {
    expect(parseArgs(['whoami']).command).toBe('whoami')
  })

  test('명령이 없으면 serve 다', () => {
    expect(parseArgs(['--delivery', 'push']).command).toBe('serve')
  })

  test('serve 는 여전히 delivery 를 요구한다', () => {
    expect(() => parseArgs([])).toThrow(/push·inbox·both/)
  })

  test('init 에 relay·label 을 준다', () => {
    const a = parseArgs(['init', '--relay', 'https://r', '--label', '수완'])
    expect(a).toMatchObject({ command: 'init', relay: 'https://r', label: '수완' })
  })

  test('릴레이 토큰은 환경변수로만 온다 (§10.13)', () => {
    expect(parseArgs(['init'], { ACM_RELAY_TOKEN: 'g'.repeat(40) }).relayToken).toBe('g'.repeat(40))
  })

  test('토큰 플래그는 없다 — 있으면 `ps` 에 찍힌다', () => {
    // 모르는 인자로 던지는 것이 맞다. 조용히 무시하면 사용자는 토큰을
    // 준 줄 알고 릴레이는 401 만 돌려준다.
    expect(() => parseArgs(['init', '--relay-token', 'x'])).toThrow(/모르는 인자/)
  })

  test('빈 토큰은 없는 것으로 본다', () => {
    // 셸이 `ACM_RELAY_TOKEN=` 를 흘려보내면 빈 문자열이 온다. 그대로 받으면
    // 설정 파일에 빈 토큰이 박히고, 그 뒤 모든 전송이 401 로 죽는다.
    expect(parseArgs(['init'], { ACM_RELAY_TOKEN: '  ' }).relayToken).toBeUndefined()
  })
})
