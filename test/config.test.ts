/**
 * 설정·진입점 테스트
 *
 * 여기서 지키는 것은 두 가지다 — 잘못된 설정이 조용히 반쪽 동작하지 않는 것,
 * 그리고 시드가 든 파일이 넓은 권한으로 읽히지 않는 것.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { toHex } from '../src/identity/fingerprint.js'
import {
  loadConfig,
  buildNode,
  validate,
  fromHex,
  expandHome,
  type Config,
} from '../src/adapter/config.js'
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
})
