/**
 * UpstashStore 를 릴레이 HTTP 경로에 꽂아 왕복시킨다.
 *
 * `upstash.test.ts` 는 우리가 **어떤 명령을 보내는지**만 본다. 여기서는
 * 그 명령들을 실제로 수행하는 가짜 Redis 를 두고 **전달이 되는지**를 본다.
 * 명령 모양이 맞아도 조합이 틀리면 메시지가 사라지는데, 그건 모양 테스트로
 * 잡히지 않는다.
 *
 * 여전히 실제 Upstash 는 아니다 — REST 응답 형태가 우리가 가정한 것과
 * 다르면 여기서는 통과하고 배포 후에 깨진다.
 */
import { test, expect } from 'bun:test'
import { createHandler } from '../src/relay/http.js'
import { UpstashStore } from '../src/relay/upstash.js'
import { createIdentity, deriveTag, seal, encode, receive, ReplayGuard, sign, type Identity } from '../src/index.js'
import { fetchAuthHeaders, fetchSigningBytes, newFetchNonce } from '../src/relay/fetch-auth.js'

/** 명령 의미를 실제로 구현하는 가짜 Redis. */
function fakeRedis() {
  const db = new Map<string, string[]>()
  const ttl = new Map<string, number>()

  function run(cmd: string[]): unknown {
    const [op, key, ...rest] = cmd as [string, string, ...string[]]
    switch (op) {
      case 'RPUSH': {
        const list = db.get(key) ?? []
        list.push(...rest)
        db.set(key, list)
        return list.length
      }
      case 'LPOP': {
        const list = db.get(key)
        if (!list || list.length === 0) return null
        const taken = list.splice(0, Number(rest[0] ?? 1))
        if (list.length === 0) {
          // 마지막 항목이 나가면 Redis 는 키를 지우고 TTL 도 함께 사라진다.
          db.delete(key)
          ttl.delete(key)
        }
        return taken
      }
      case 'LTRIM': {
        const list = db.get(key)
        if (!list) return 'OK'
        const start = Number(rest[0]), stop = Number(rest[1])
        const s = start < 0 ? Math.max(0, list.length + start) : start
        const e = stop < 0 ? list.length + stop : stop
        db.set(key, list.slice(s, e + 1))
        return 'OK'
      }
      case 'LLEN':
        return db.get(key)?.length ?? 0
      case 'EXPIRE':
        if (!db.has(key)) return 0
        ttl.set(key, Number(rest[0]))
        return 1
      default:
        throw new Error(`구현 안 된 명령: ${op}`)
    }
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const body = JSON.parse(String(init?.body))
    if (path === '/multi-exec') {
      return Response.json((body as string[][]).map(c => ({ result: run(c) })))
    }
    return Response.json({ result: run(body as string[]) })
  }) as unknown as typeof globalThis.fetch

  return { db, ttl, fetchImpl }
}

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

/** 수신함 조회는 서명으로 인증된다 (§10.12) — 네트워크를 지나도 마찬가지다. */
function authHeaders(who: Identity): Record<string, string> {
  const nonce = newFetchNonce()
  const timeMs = Date.now()
  return fetchAuthHeaders({
    kemPublicKey: who.kemPublicKey,
    signPublicKey: who.signPublicKey,
    signature: sign(who, fetchSigningBytes(who.keyId, timeMs, nonce)),
    timeMs,
    nonce,
  })
}

test('봉투가 Upstash 를 지나 왕복하고 복호화된다', async () => {
  const { db, ttl, fetchImpl } = fakeRedis()
  const store = new UpstashStore({ url: 'https://f.io', token: 't', fetch: fetchImpl, ttlMs: 7 * 24 * 3600_000 })
  const server = Bun.serve({ port: 0, fetch: createHandler({ store }) })
  const base = `http://127.0.0.1:${server.port}`

  try {
    const alice = await createIdentity()
    const bob = await createIdentity()
    const plaintext = new TextEncoder().encode('업스태시 경유 테스트')
    const wire = encode(
      await seal({
        sender: alice,
        // key id 는 KEM 공개키에서 파생된다 — 따로 주지 않는다.
        recipients: [{ kemPublicKey: bob.kemPublicKey, signPublicKey: bob.signPublicKey }],
        channelTag: deriveTag(crypto.getRandomValues(new Uint8Array(32))),
        seq: 1n,
        plaintext,
      }),
    )

    const posted = await fetch(`${base}/post`, { method: 'POST', body: wire })
    expect(posted.status).toBe(200)

    // EXPIRE 가 실제로 나갔다는 증거. RPUSH 만으로는 TTL 이 걸리지 않는다.
    expect(ttl.get(`acm:q:${hex(bob.keyId)}`)).toBe(7 * 24 * 3600)

    const got = await fetch(`${base}/fetch/${hex(bob.keyId)}`, { headers: authHeaders(bob) })
    const body = (await got.json()) as { messages: { envelope: string }[] }
    expect(body.messages).toHaveLength(1)

    const result = await receive({
      wire: Uint8Array.from(atob(body.messages[0]!.envelope), c => c.charCodeAt(0)),
      recipient: bob,
      guard: new ReplayGuard(),
      lookupSender: () => alice.signPublicKey,
    })
    expect(result.ok).toBe(true)
    expect(new TextDecoder().decode((result as { plaintext: Uint8Array }).plaintext)).toBe('업스태시 경유 테스트')

    // 드레인은 비우는 것이다 — 두 번째 폴링에 같은 메시지가 또 오면 안 된다.
    const again = await fetch(`${base}/fetch/${hex(bob.keyId)}`, { headers: authHeaders(bob) })
    expect(((await again.json()) as { messages: unknown[] }).messages).toHaveLength(0)
    expect(db.has(`acm:q:${hex(bob.keyId)}`)).toBe(false)
  } finally {
    server.stop()
  }
})

test('maxQueue 를 넘으면 오래된 것부터 버린다', async () => {
  const { fetchImpl } = fakeRedis()
  const store = new UpstashStore({ url: 'https://f.io', token: 't', fetch: fetchImpl, maxQueue: 3 })
  for (let i = 0; i < 5; i++) {
    await store.push('cap', { envelope: new Uint8Array([i]), receivedAt: i })
  }
  const kept = await store.drain('cap', 10)
  // 새 메시지를 거부하지 않는다 — 활발한 채널이 죽은 큐 하나에 막히면 안 된다.
  expect(kept.map(k => k.envelope[0])).toEqual([2, 3, 4])
})

test('FIFO 다 — 보낸 순서대로 나온다', async () => {
  const { fetchImpl } = fakeRedis()
  const store = new UpstashStore({ url: 'https://f.io', token: 't', fetch: fetchImpl })
  for (let i = 0; i < 4; i++) {
    await store.push('q', { envelope: new Uint8Array([i]), receivedAt: i })
  }
  expect((await store.drain('q', 10)).map(k => k.envelope[0])).toEqual([0, 1, 2, 3])
})

test('부분 드레인 뒤 남은 것이 순서대로 이어진다', async () => {
  const { fetchImpl } = fakeRedis()
  const store = new UpstashStore({ url: 'https://f.io', token: 't', fetch: fetchImpl })
  for (let i = 0; i < 5; i++) {
    await store.push('q', { envelope: new Uint8Array([i]), receivedAt: i })
  }
  expect((await store.drain('q', 2)).map(k => k.envelope[0])).toEqual([0, 1])
  expect(await store.depth('q')).toBe(3)
  expect((await store.drain('q', 10)).map(k => k.envelope[0])).toEqual([2, 3, 4])
})
