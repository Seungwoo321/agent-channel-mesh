/**
 * Upstash 저장소 테스트.
 *
 * 실제 Upstash 없이 검증한다 — `fetch` 를 주입해 어떤 Redis 명령을 보내는지
 * 확인하고, 응답을 흉내낸다. **이 테스트는 우리가 보내는 명령이 의도대로인지만
 * 증명한다.** Upstash 가 그 명령에 어떻게 답하는지는 실제 DB 로만 확인된다.
 */
import { test, expect } from 'bun:test'
import { UpstashStore, UpstashError, fromEnv } from '../src/relay/upstash.js'
import type { Stored } from '../src/relay/store.js'

/** 주고받은 요청을 기록하는 가짜 `fetch`. */
function fake(reply: (path: string, body: unknown) => unknown) {
  const calls: { path: string; body: unknown; auth: string }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body))
    const headers = init?.headers as Record<string, string>
    calls.push({ path: new URL(url).pathname, body, auth: headers.authorization ?? '' })
    return new Response(JSON.stringify(reply(new URL(url).pathname, body)), {
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetchImpl }
}

function store(fetchImpl: typeof globalThis.fetch, options = {}) {
  return new UpstashStore({
    url: 'https://example.upstash.io',
    token: 'tok',
    fetch: fetchImpl,
    ...options,
  })
}

const item: Stored = { envelope: new Uint8Array([1, 2, 3, 250, 255]), receivedAt: 1_700_000_000_000 }

test('push 는 RPUSH·LTRIM·EXPIRE 를 한 번에 원자적으로 보낸다', async () => {
  const { calls, fetchImpl } = fake(() => [{ result: 1 }, { result: 'OK' }, { result: 1 }])
  await store(fetchImpl).push('abc123', item)

  expect(calls).toHaveLength(1)
  // /multi-exec 이어야 한다. /pipeline 은 원자적이지 않아서 RPUSH 만 되고
  // EXPIRE 가 실패하면 그 큐가 영원히 남는다.
  expect(calls[0]!.path).toBe('/multi-exec')
  const commands = calls[0]!.body as string[][]
  expect(commands.map(c => c[0])).toEqual(['RPUSH', 'LTRIM', 'EXPIRE'])
})

test('EXPIRE 를 push 마다 다시 건다 — RPUSH 는 TTL 을 갱신하지 않는다', async () => {
  const { calls, fetchImpl } = fake(() => [{ result: 1 }, { result: 'OK' }, { result: 1 }])
  const s = store(fetchImpl, { ttlMs: 60_000 })
  await s.push('abc123', item)
  await s.push('abc123', item)

  for (const call of calls) {
    const expire = (call.body as string[][]).find(c => c[0] === 'EXPIRE')!
    expect(expire[2]).toBe('60')
  }
})

test('TTL 은 초로 올림한다 — 내림하면 의도보다 짧아진다', async () => {
  const { calls, fetchImpl } = fake(() => [{ result: 1 }, { result: 'OK' }, { result: 1 }])
  await store(fetchImpl, { ttlMs: 1_500 }).push('abc123', item)
  expect((calls[0]!.body as string[][])[2]![2]).toBe('2')
})

test('LTRIM 이 뒤에서부터 maxQueue 개만 남긴다', async () => {
  const { calls, fetchImpl } = fake(() => [{ result: 1 }, { result: 'OK' }, { result: 1 }])
  await store(fetchImpl, { maxQueue: 10 }).push('abc123', item)
  const trim = (calls[0]!.body as string[][]).find(c => c[0] === 'LTRIM')!
  expect(trim.slice(2)).toEqual(['-10', '-1'])
})

test('drain 은 LPOP 한 번이다 — LRANGE+LTRIM 이 아니다', async () => {
  const { calls, fetchImpl } = fake(() => ({ result: null }))
  await store(fetchImpl).drain('abc123', 50)

  expect(calls).toHaveLength(1)
  expect(calls[0]!.body).toEqual(['LPOP', 'acm:q:abc123', '50'])
})

test('push 한 봉투가 drain 으로 바이트까지 그대로 돌아온다', async () => {
  let stored: string | undefined
  const { fetchImpl } = fake((path, body) => {
    if (path === '/multi-exec') {
      stored = (body as string[][])[0]![2]
      return [{ result: 1 }, { result: 'OK' }, { result: 1 }]
    }
    return { result: [stored] }
  })
  const s = store(fetchImpl)
  await s.push('abc123', item)
  const [got] = await s.drain('abc123', 10)

  expect(got!.receivedAt).toBe(item.receivedAt)
  expect([...got!.envelope]).toEqual([...item.envelope])
})

test('빈 큐는 null 로 오고 빈 배열이 된다', async () => {
  const { fetchImpl } = fake(() => ({ result: null }))
  expect(await store(fetchImpl).drain('abc123', 10)).toEqual([])
})

test('limit 이 0 이면 요청 자체를 보내지 않는다', async () => {
  const { calls, fetchImpl } = fake(() => ({ result: null }))
  expect(await store(fetchImpl).drain('abc123', 0)).toEqual([])
  expect(calls).toHaveLength(0)
})

test('depth 는 LLEN 이다', async () => {
  const { calls, fetchImpl } = fake(() => ({ result: 7 }))
  expect(await store(fetchImpl).depth('abc123')).toBe(7)
  expect(calls[0]!.body).toEqual(['LLEN', 'acm:q:abc123'])
})

test('토큰을 Bearer 로 보낸다', async () => {
  const { calls, fetchImpl } = fake(() => ({ result: 0 }))
  await store(fetchImpl).depth('abc123')
  expect(calls[0]!.auth).toBe('Bearer tok')
})

test('키에 접두를 붙여 다른 용도와 섞이지 않게 한다', async () => {
  const { calls, fetchImpl } = fake(() => ({ result: 0 }))
  await store(fetchImpl, { prefix: 'x:' }).depth('abc123')
  expect(calls[0]!.body).toEqual(['LLEN', 'x:abc123'])
})

test('Redis 에러를 삼키지 않고 던진다', async () => {
  const { fetchImpl } = fake(() => ({ error: 'WRONGTYPE' }))
  expect(store(fetchImpl).depth('abc123')).rejects.toThrow(UpstashError)
})

test('multi-exec 안의 실패도 던진다 — 하나만 실패해도 push 는 실패다', async () => {
  const { fetchImpl } = fake(() => [{ result: 1 }, { error: 'ERR bad trim' }, { result: 1 }])
  expect(store(fetchImpl).push('abc123', item)).rejects.toThrow('ERR bad trim')
})

test('HTTP 실패를 던진다', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof globalThis.fetch
  expect(store(fetchImpl).depth('abc123')).rejects.toThrow('401')
})

test('네트워크 실패를 던진다 — 조용히 성공한 척하지 않는다', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch
  expect(store(fetchImpl).push('abc123', item)).rejects.toThrow(UpstashError)
})

test('자격이 비면 생성 시점에 죽는다', () => {
  expect(() => new UpstashStore({ url: '', token: 'tok' })).toThrow(UpstashError)
  expect(() => new UpstashStore({ url: 'https://x', token: '' })).toThrow(UpstashError)
})

test('URL 끝 슬래시를 지워 이중 슬래시가 되지 않게 한다', async () => {
  const { calls, fetchImpl } = fake(() => ({ result: 0 }))
  await new UpstashStore({ url: 'https://example.upstash.io/', token: 't', fetch: fetchImpl }).depth('a')
  expect(calls[0]!.path).toBe('/')
})

test('fromEnv 는 UPSTASH_ 와 KV_ 두 관례를 모두 읽는다', () => {
  expect(fromEnv({ UPSTASH_REDIS_REST_URL: 'https://a', UPSTASH_REDIS_REST_TOKEN: 't' })).toBeInstanceOf(UpstashStore)
  expect(fromEnv({ KV_REST_API_URL: 'https://a', KV_REST_API_TOKEN: 't' })).toBeInstanceOf(UpstashStore)
})

test('fromEnv 는 자격이 없으면 무엇을 설정해야 하는지 말하며 죽는다', () => {
  expect(() => fromEnv({})).toThrow(/UPSTASH_REDIS_REST_URL/)
})
