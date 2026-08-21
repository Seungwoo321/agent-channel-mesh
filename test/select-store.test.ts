/**
 * 저장소 선택 테스트.
 *
 * 세 분기 중 "서버리스 + 자격 없음"이 봉투 유실과 프로덕션 사이에 서 있는
 * 유일한 검사다 — 그 분기가 조용히 사라져도 로컬 테스트는 전부 통과하고
 * 배포판만 봉투를 버리게 되므로, 여기서 못 박는다.
 *
 * `process.env` 가 아니라 인자로 환경을 받는 함수라 전역을 건드리지 않고
 * 세 경우를 다 만들 수 있다.
 */
import { test, expect, describe } from 'bun:test'
import { selectStore } from '../src/relay/select-store.js'
import { MemoryStore, DEFAULT_TTL_MS, DEFAULT_MAX_QUEUE } from '../src/relay/store.js'
import { UpstashStore } from '../src/relay/upstash.js'
import { TursoStore, TursoError, type TursoClient } from '../src/relay/turso.js'

const limits = { ttlMs: DEFAULT_TTL_MS, maxQueue: DEFAULT_MAX_QUEUE }

const credentials = {
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token',
}

const tursoCredentials = {
  TURSO_DATABASE_URL: 'libsql://example.turso.io',
  TURSO_AUTH_TOKEN: 'token',
}

describe('저장소 선택', () => {
  test('자격이 있으면 Upstash 다', () => {
    const selection = selectStore(credentials, limits)
    expect(selection.store).toBeInstanceOf(UpstashStore)
    expect(selection.provider).toBe('upstash')
    expect(selection.durable).toBe(true)
  })

  test('자격이 있으면 서버리스에서도 Upstash 다', () => {
    const selection = selectStore({ ...credentials, VERCEL: '1' }, limits)
    expect(selection.store).toBeInstanceOf(UpstashStore)
    expect(selection.provider).toBe('upstash')
    expect(selection.durable).toBe(true)
  })

  test('레거시 KV_* 이름도 자격으로 인정한다', () => {
    // Vercel 의 Upstash 통합이 프로젝트에 따라 이 이름으로 넣는다. 못 알아보면
    // 자격이 있는데도 서버리스에서 기동 실패한다.
    const selection = selectStore(
      { KV_REST_API_URL: 'https://example.upstash.io', KV_REST_API_TOKEN: 'token', VERCEL: '1' },
      limits,
    )
    expect(selection.store).toBeInstanceOf(UpstashStore)
  })

  test('ACM_RELAY_STORE=turso 이면 Turso 를 명시적으로 선택한다', () => {
    const selection = selectStore({ ...tursoCredentials, ACM_RELAY_STORE: 'turso' }, limits)
    expect(selection.store).toBeInstanceOf(TursoStore)
    expect(selection.provider).toBe('turso')
    expect(selection.durable).toBe(true)
  })

  test('ACM_RELAY_STORE=upstash 이면 다른 자격보다 Upstash 를 우선한다', () => {
    const selection = selectStore({ ...credentials, ...tursoCredentials, ACM_RELAY_STORE: 'upstash' }, limits)
    expect(selection.store).toBeInstanceOf(UpstashStore)
    expect(selection.provider).toBe('upstash')
  })

  test('ACM_RELAY_STORE=memory 는 로컬 메모리 릴레이를 선택한다', () => {
    const selection = selectStore({ ACM_RELAY_STORE: 'memory' }, limits)
    expect(selection.store).toBeInstanceOf(MemoryStore)
    expect(selection.provider).toBe('memory')
    expect(selection.durable).toBe(false)
  })

  test('local 은 memory 의 사용자 친화적 별칭이다', () => {
    expect(selectStore({ ACM_RELAY_STORE: 'local' }, limits).provider).toBe('memory')
  })

  test('자격이 없고 로컬이면 메모리다 — 설정 없이 띄울 수 있어야 한다', () => {
    const selection = selectStore({}, limits)
    expect(selection.store).toBeInstanceOf(MemoryStore)
    expect(selection.provider).toBe('memory')
    expect(selection.durable).toBe(false)
  })

  test('자격이 없고 서버리스면 던진다', () => {
    // 인스턴스마다 메모리가 갈려 봉투가 조용히 사라진다. 200 을 돌려주면서
    // 메시지를 버리는 릴레이보다 기동 실패가 낫다.
    expect(() => selectStore({ VERCEL: '1' }, limits)).toThrow(/ACM_RELAY_STORE/)
  })

  test('토큰만 있고 URL 이 없으면 자격으로 치지 않는다', () => {
    expect(() => selectStore({ UPSTASH_REDIS_REST_TOKEN: 'token', VERCEL: '1' }, limits)).toThrow()
  })

  test('Turso 자격이 일부만 있으면 자동 fallback 하지 않는다', () => {
    expect(() => selectStore({ TURSO_DATABASE_URL: 'libsql://example.turso.io' }, limits)).toThrow(/Turso 자격이 불완전하다/)
  })

  test('두 DB 자격이 모두 있으면 provider 를 추측하지 않는다', () => {
    expect(() => selectStore({ ...credentials, ...tursoCredentials }, limits)).toThrow(/ACM_RELAY_STORE/)
  })

  test('알 수 없는 provider 를 메모리로 삼키지 않는다', () => {
    expect(() => selectStore({ ACM_RELAY_STORE: 'sqlite' }, limits)).toThrow(/memory.*turso.*upstash/)
  })
})

describe('Turso 큐 저장소', () => {
  test('스키마·push·drain 을 모두 원자적 immediate 배치로 보낸다', async () => {
    const calls: { statements: unknown[]; mode: unknown }[] = []
    let nextRows: unknown[] | undefined
    const client: TursoClient = {
      batch: async (statements, mode) => {
        calls.push({ statements, mode })
        return nextRows === undefined ? [] : [{}, { rows: nextRows }]
      },
    }
    const store = new TursoStore({
      url: 'libsql://example.turso.io',
      token: 'token',
      client,
      namespace: 'test',
      ttlMs: 60_000,
      maxQueue: 3,
      now: () => 1_700_000_000_000,
    })
    const item = { envelope: new Uint8Array([1, 2, 255]), receivedAt: 1_700_000_000_000 }

    await store.push('recipient', item)
    nextRows = [{ received_at: item.receivedAt, envelope: item.envelope }]
    const got = await store.drain('recipient', 10)

    expect(calls).toHaveLength(3)
    expect(calls.every(call => call.mode === 'immediate')).toBe(true)
    expect((calls[1]!.statements[2] as { sql: string }).sql).toContain('LIMIT ?')
    expect((calls[2]!.statements[1] as { sql: string }).sql).toContain('RETURNING received_at, envelope')
    expect(got).toEqual([item])
  })

  test('depth 는 만료 정리 뒤 live 행 수를 반환한다', async () => {
    const calls: unknown[] = []
    const client: TursoClient = {
      batch: async statements => {
        calls.push(statements)
        return calls.length === 1 ? [] : [{}, { rows: [{ count: 4 }] }]
      },
    }
    const store = new TursoStore({ url: 'libsql://example.turso.io', token: 'token', client })

    expect(await store.depth('recipient')).toBe(4)
    expect(calls).toHaveLength(2)
  })

  test('자격이 비면 생성 시점에 설명 가능한 오류를 낸다', () => {
    expect(() => new TursoStore({ url: '', token: 'token' })).toThrow(/TURSO_DATABASE_URL/)
    expect(() => new TursoStore({ url: 'libsql://example.turso.io', token: '' })).toThrow(/TURSO_AUTH_TOKEN/)
  })
})
