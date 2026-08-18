/**
 * 권한 정책 테스트 (§8「권한」)
 *
 * 여기서 지키는 것은 하나다 — **모르는 것은 막힌다.** 분류표에 없는 툴,
 * 설정에 없는 발신자, 필드가 없는 옛 저장 파일은 전부 좁은 쪽으로 떨어져야
 * 한다. 반대로 떨어지면 동료의 말이 조용히 내 기계 권한을 얻는다.
 */
import { test, expect, describe } from 'bun:test'
import {
  allows,
  buildPolicy,
  DEFAULT_PEER_GRANT,
  grantOf,
  lower,
  OPEN_POLICY,
  recordAuthority,
  recordGrant,
  toolGrant,
} from '../src/policy/authority.js'
import { toHex, toKey } from '../src/identity/fingerprint.js'

const FP = new Uint8Array(16).fill(0xab)
const KEY = toKey(FP)

describe('사다리', () => {
  test('read < write < execute', () => {
    expect(allows('execute', 'write')).toBe(true)
    expect(allows('write', 'execute')).toBe(false)
    expect(allows('read', 'read')).toBe(true)
  })

  test('겹치면 좁은 쪽이 남는다', () => {
    expect(lower('execute', 'read')).toBe('read')
    expect(lower('write', 'execute')).toBe('write')
  })
})

describe('정책', () => {
  test('적히지 않은 동료는 읽기다', () => {
    expect(grantOf(OPEN_POLICY, 'peer', KEY)).toBe(DEFAULT_PEER_GRANT)
    expect(grantOf(OPEN_POLICY, 'peer', undefined)).toBe(DEFAULT_PEER_GRANT)
  })

  test('내 다른 에이전트는 사다리 꼭대기다', () => {
    expect(grantOf(OPEN_POLICY, 'self', KEY)).toBe('execute')
  })

  test('지문에 적은 사람만 기본값을 벗어난다', () => {
    const policy = buildPolicy({ peers: { [toHex(FP)]: 'write' } })
    expect(grantOf(policy, 'peer', KEY)).toBe('write')
    expect(grantOf(policy, 'peer', toKey(new Uint8Array(16).fill(1)))).toBe('read')
  })

  test('띄어 쓴 지문 표기도 같은 키다 — 화면에 보이는 형태가 그것이다', () => {
    const spaced = toHex(FP)
    expect(spaced).toContain(' ')
    expect(grantOf(buildPolicy({ peers: { [spaced]: 'execute' } }), 'peer', KEY)).toBe('execute')
  })

  test('등급 오타는 던진다 — 조용히 기본값으로 떨어지면 안 걸린 줄 모른다', () => {
    expect(() => buildPolicy({ peers: { [toHex(FP)]: 'exec' } })).toThrow('policy.peers')
    expect(() => buildPolicy({ default: 'full' })).toThrow('policy.default')
  })
})

describe('저장된 한 건', () => {
  test('내가 보낸 것은 필드가 없어도 나다', () => {
    expect(recordAuthority({ direction: 'out' })).toBe('self')
    expect(recordGrant({ direction: 'out' })).toBe('execute')
  })

  test('옛 저장 파일(필드 없음)은 동료·읽기로 읽는다', () => {
    expect(recordAuthority({ direction: 'in' })).toBe('peer')
    expect(recordGrant({ direction: 'in' })).toBe('read')
  })

  test('찍힌 값을 그대로 쓴다 — 정책이 바뀌어도 들인 근거는 안 바뀐다', () => {
    expect(recordGrant({ direction: 'in', authority: 'peer', grant: 'write' })).toBe('write')
    expect(recordAuthority({ direction: 'in', authority: 'self' })).toBe('self')
  })
})

describe('툴 분류', () => {
  test('읽기·쓰기는 두 에이전트 이름을 모두 안다', () => {
    for (const t of ['Read', 'Grep', 'read_file', 'list_dir']) expect(toolGrant(t)).toBe('read')
    for (const t of ['Edit', 'Write', 'apply_patch']) expect(toolGrant(t)).toBe('write')
  })

  test('모르는 이름은 execute 다', () => {
    expect(toolGrant('Bash')).toBe('execute')
    expect(toolGrant('shell')).toBe('execute')
    expect(toolGrant('무언가_새로_생긴_툴')).toBe('execute')
    expect(toolGrant('')).toBe('execute')
  })

  test('네트워크로 나가는 툴은 읽기가 아니다 — 그 자체가 유출 통로다', () => {
    expect(toolGrant('WebFetch')).toBe('execute')
    expect(toolGrant('WebSearch')).toBe('execute')
  })

  test('우리 서버의 대화 툴만 읽기다 — 동료에게 답은 할 수 있어야 한다', () => {
    expect(toolGrant('mcp__agent-channel-mesh__send')).toBe('read')
    expect(toolGrant('mcp__plugin_agent-channel-mesh_acm__inbox')).toBe('read')
    // 신원을 만드는 일이라 읽기가 아니다.
    expect(toolGrant('mcp__agent-channel-mesh__setup')).toBe('execute')
  })

  test('남의 MCP 툴은 이름만으로 무엇을 하는지 알 수 없다', () => {
    expect(toolGrant('mcp__other__read')).toBe('execute')
    expect(toolGrant('mcp__broken')).toBe('execute')
  })
})
