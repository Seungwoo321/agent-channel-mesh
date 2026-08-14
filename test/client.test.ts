/**
 * 릴레이 클라이언트 테스트
 *
 * 클라이언트를 실제 HTTP 핸들러에 직접 물린다 — 목을 세우면 클라이언트와
 * 릴레이가 다른 형식을 주고받아도 양쪽 테스트가 통과한다. 두 계층 사이의
 * 계약이 이 파일이 지키는 것이다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.ts'
import { Channel } from '../src/channel/channel.ts'
import { MeshNode } from '../src/node/node.ts'
import { MemoryStore } from '../src/relay/store.ts'
import { createHandler } from '../src/relay/http.ts'
import { RelayClient, RelayError } from '../src/relay/client.ts'
import { MAX_ENVELOPE_BYTES } from '../src/relay/relay.ts'

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

/** 핸들러를 fetch 처럼 보이게 감싼다. 네트워크 없이 진짜 릴레이를 쓴다. */
function wired() {
  const handle = createHandler({ store: new MemoryStore() })
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    handle(new Request(input as string, init))) as typeof globalThis.fetch
  return {
    fetch,
    client: (identity: Identity, pollMs = 1) =>
      new RelayClient({ baseUrl: 'http://relay', keyId: identity.keyId, pollMs, fetch }),
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
  const relayFor = (id: Identity) =>
    new RelayClient({ baseUrl: 'http://relay', keyId: id.keyId, pollMs: 1, fetch })
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
      keyId: bob.keyId,
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
