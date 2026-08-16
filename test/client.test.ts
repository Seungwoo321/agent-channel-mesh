/**
 * 릴레이 클라이언트 테스트
 *
 * 클라이언트를 실제 HTTP 핸들러에 직접 물린다 — 목을 세우면 클라이언트와
 * 릴레이가 다른 형식을 주고받아도 양쪽 테스트가 통과한다. 두 계층 사이의
 * 계약이 이 파일이 지키는 것이다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.js'
import { Channel } from '../src/channel/channel.js'
import { MeshNode } from '../src/node/node.js'
import { MemoryStore } from '../src/relay/store.js'
import { createHandler } from '../src/relay/http.js'
import { RelayClient, RelayError } from '../src/relay/client.js'
import { MAX_ENVELOPE_BYTES } from '../src/relay/relay.js'
import {
  HEADER_KEM,
  HEADER_NONCE,
  HEADER_SIG,
  HEADER_SIGN,
  HEADER_TIME,
  parseFetchAuth,
  verifyFetchAuth,
} from '../src/relay/fetch-auth.js'

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** 핸들러를 fetch 처럼 보이게 감싼다. 네트워크 없이 진짜 릴레이를 쓴다. */
function wired() {
  const handle = createHandler({ store: new MemoryStore() })
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    handle(new Request(input as string, init))) as typeof globalThis.fetch
  return {
    fetch,
    client: (identity: Identity, pollMs = 1) =>
      new RelayClient({ baseUrl: 'http://relay', identity, pollMs, fetch }),
  }
}

/** 같은 비밀을 아는 두 노드. 릴레이는 각자 붙인다. */
function pair(fetch: typeof globalThis.fetch) {
  const secret = new Channel().secret
  const build = () => {
    const ch = new Channel({ secret })
    ch.add({ signPublicKey: alice.signPublicKey, kemPublicKey: alice.kemPublicKey, label: 'alice' })
    ch.add({ signPublicKey: bob.signPublicKey, kemPublicKey: bob.kemPublicKey, label: 'bob' })
    return ch
  }
  const relayFor = (identity: Identity) =>
    new RelayClient({ baseUrl: 'http://relay', identity, pollMs: 1, fetch })
  const nodeA = new MeshNode({ identity: alice, relay: relayFor(alice) })
  const nodeB = new MeshNode({ identity: bob, relay: relayFor(bob) })
  const id = nodeA.join(build())
  nodeB.join(build())
  return { nodeA, nodeB, id }
}

describe('올리고 내리기', () => {
  test('올린 봉투를 수신자가 내려받는다', async () => {
    const { fetch, client } = wired()
    const { nodeA, id } = pair(fetch)
    await nodeA.send(id, '릴레이 왕복')

    const got = await client(bob).fetchInbox()
    expect(got).toHaveLength(1)
  })

  test('꺼내면 비워진다', async () => {
    const { fetch, client } = wired()
    const { nodeA, id } = pair(fetch)
    await nodeA.send(id, 'x')
    const c = client(bob)
    expect(await c.fetchInbox()).toHaveLength(1)
    expect(await c.fetchInbox()).toHaveLength(0)
  })

  test('발신자 큐에는 들어가지 않는다', async () => {
    const { fetch, client } = wired()
    const { nodeA, id } = pair(fetch)
    await nodeA.send(id, 'x')
    expect(await client(alice).fetchInbox()).toHaveLength(0)
  })

  test('base64 왕복이 봉투를 보존한다 — 두 계층의 계약', async () => {
    const { fetch, client } = wired()
    const { nodeA, nodeB, id } = pair(fetch)
    await nodeA.send(id, '바이트 보존 확인')
    const [wire] = await client(bob).fetchInbox()

    const got = await nodeB.accept(wire!)
    expect(got).toMatchObject({ text: '바이트 보존 확인' })
  })
})

describe('실패', () => {
  test('거부는 던진다 — 조용한 유실이 최악이다', async () => {
    const { client } = wired()
    await expect(client(alice).post(new Uint8Array(300))).rejects.toThrow(RelayError)
  })

  test('거부 사유를 실어 준다', async () => {
    const { client } = wired()
    const err = await client(alice)
      .post(new Uint8Array(MAX_ENVELOPE_BYTES + 1))
      .catch(e => e as RelayError)
    expect(err).toBeInstanceOf(RelayError)
    expect((err as RelayError).reason).toBe('too-large')
    expect((err as RelayError).status).toBe(413)
  })
})

describe('폴링', () => {
  test('도착한 것을 흘려 준다', async () => {
    const { fetch, client } = wired()
    const { nodeA, id } = pair(fetch)
    await nodeA.send(id, '하나')
    await nodeA.send(id, '둘')

    const c = client(bob)
    const got: Uint8Array[] = []
    for await (const wire of c.poll()) {
      got.push(wire)
      if (got.length === 2) c.stop()
    }
    expect(got).toHaveLength(2)
  })

  test('stop 이 루프를 끝낸다', async () => {
    const { client } = wired()
    const c = client(bob, 1)
    c.stop()
    const got: Uint8Array[] = []
    for await (const wire of c.poll()) got.push(wire)
    expect(got).toHaveLength(0)
    expect(c.running).toBe(false)
  })

  test('릴레이가 죽어도 루프가 죽지 않는다', async () => {
    // 신뢰하지 않는 것에는 가용성도 기대하지 않는다.
    let calls = 0
    const failing = (async () => {
      calls++
      throw new Error('연결 실패')
    }) as unknown as typeof globalThis.fetch
    const c = new RelayClient({
      baseUrl: 'http://죽은릴레이',
      identity: bob,
      pollMs: 1,
      fetch: failing,
    })
    const it = c.poll()
    // 실패해도 예외가 밖으로 나오지 않고 다음 회차를 준비한다.
    const race = await Promise.race([
      it.next().then(() => 'yielded'),
      new Promise(r => setTimeout(() => r('여전히 살아 있음'), 60)),
    ])
    c.stop()
    expect(race).toBe('여전히 살아 있음')
    expect(calls).toBeGreaterThan(0)
  })
})

describe('수신함 조회 인증 (§10.12)', () => {
  /** 요청 헤더를 붙잡으면서 진짜 핸들러로 넘긴다. 목이 아니라 관찰이다. */
  function capturing() {
    const handle = createHandler({ store: new MemoryStore() })
    const seen: Headers[] = []
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input as string, init)
      seen.push(req.headers)
      return handle(req)
    }) as typeof globalThis.fetch
    return {
      seen,
      client: (identity: Identity) =>
        new RelayClient({ baseUrl: 'http://relay', identity, pollMs: 1, fetch }),
    }
  }

  test('조회 요청이 릴레이가 검증할 수 있는 인증 헤더를 싣는다', async () => {
    const { seen, client } = capturing()
    await client(bob).fetchInbox()

    const headers = seen[0]!
    for (const name of [HEADER_KEM, HEADER_SIGN, HEADER_SIG, HEADER_TIME, HEADER_NONCE]) {
      expect(headers.get(name)).not.toBeNull()
    }

    // 헤더가 실렸다는 것만으로는 부족하다 — 릴레이가 쓰는 바로 그 검증기를
    // 통과해야 2c 에서 강제를 켜도 클라이언트가 살아남는다.
    const auth = parseFetchAuth(headers)
    expect(auth).not.toBeNull()
    expect(verifyFetchAuth(hex(bob.keyId), auth!, Date.now())).toEqual({ ok: true })
  })

  test('남의 key id 로는 검증되지 않는다 — 서명이 큐에 묶여 있다', async () => {
    const { seen, client } = capturing()
    await client(bob).fetchInbox()

    const auth = parseFetchAuth(seen[0]!)
    expect(verifyFetchAuth(hex(alice.keyId), auth!, Date.now())).toMatchObject({
      ok: false,
      reason: 'key-id-mismatch',
    })
  })

  test('매 요청의 nonce 가 다르다', async () => {
    const { seen, client } = capturing()
    const c = client(bob)
    await c.fetchInbox()
    await c.fetchInbox()

    expect(seen).toHaveLength(2)
    expect(seen[0]!.get(HEADER_NONCE)).not.toBe(seen[1]!.get(HEADER_NONCE))
    // 서명도 함께 갈린다 — 같은 밀리초에 서명해도 재생할 바이트가 겹치지 않는다.
    expect(seen[0]!.get(HEADER_SIG)).not.toBe(seen[1]!.get(HEADER_SIG))
  })
})

describe('노드 통합', () => {
  test('listen 이 복호화된 메시지를 준다', async () => {
    const { fetch } = wired()
    const { nodeA, nodeB, id } = pair(fetch)
    await nodeA.send(id, '끝까지 통과')

    for await (const message of nodeB.listen()) {
      expect(message.text).toBe('끝까지 통과')
      expect(message.senderLabel).toBe('alice')
      nodeB.stop()
    }
  })

  test('릴레이 없는 노드는 listen 하지 못한다', async () => {
    const node = new MeshNode({ identity: alice })
    await expect(node.listen().next()).rejects.toThrow(/릴레이가 없다/)
  })
})
