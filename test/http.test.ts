/**
 * 릴레이 HTTP 테스트
 *
 * HTTP 계층이 얇다는 것을 확인하는 자리다 — 상태 코드와 직렬화만 본다.
 * 라우팅 로직은 relay.test.ts 가 이미 덮는다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, type Identity } from '../src/identity/keys.ts'
import { seal } from '../src/crypto/seal.ts'
import { encode } from '../src/crypto/envelope.ts'
import { MemoryStore } from '../src/relay/store.ts'
import {
  createHandler,
  fromBase64,
  type PostBody,
  type FetchBody,
  type ErrorBody,
  type HealthBody,
} from '../src/relay/http.ts'
import { MAX_ENVELOPE_BYTES } from '../src/relay/relay.ts'
import { receive } from '../src/crypto/receive.ts'
import { ReplayGuard } from '../src/crypto/replay.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const TAG = new Uint8Array(16).fill(0xab)

let alice: Identity
let bob: Identity

beforeAll(async () => {
  ;[alice, bob] = await Promise.all([createIdentity(), createIdentity()])
})

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

const handler = () => createHandler({ store: new MemoryStore() })

async function envelopeFor(text: string, seq = 1n) {
  return encode(
    await seal({
      sender: alice,
      recipients: [{ kemPublicKey: bob.kemPublicKey }],
      channelTag: TAG,
      seq,
      plaintext: enc.encode(text),
    }),
  )
}

const post = (h: ReturnType<typeof handler>, body: Uint8Array) =>
  h(new Request('http://relay/post', { method: 'POST', body }))

const get = (h: ReturnType<typeof handler>, path: string) =>
  h(new Request(`http://relay${path}`))

describe('POST /post', () => {
  test('봉투를 받는다', async () => {
    const res = await post(handler(), await envelopeFor('안녕'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as PostBody
    expect(body).toMatchObject({ ok: true, recipients: 1 })
    expect(body.messageId).toMatch(/^[0-9a-f]{32}$/)
  })

  test('형식이 아니면 400 이다', async () => {
    const res = await post(handler(), new Uint8Array(300))
    expect(res.status).toBe(400)
    expect((await res.json()) as ErrorBody).toMatchObject({ ok: false, reason: 'malformed' })
  })

  test('너무 크면 413 이다 — 클라이언트가 구분해 대응한다', async () => {
    const res = await post(handler(), new Uint8Array(MAX_ENVELOPE_BYTES + 1))
    expect(res.status).toBe(413)
    expect((await res.json()) as ErrorBody).toMatchObject({ ok: false, reason: 'too-large' })
  })
})

describe('GET /fetch/<key id>', () => {
  test('넣은 것을 꺼낸다', async () => {
    const h = handler()
    await post(h, await envelopeFor('릴레이 경유'))
    const res = await get(h, `/fetch/${hex(bob.keyId)}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as FetchBody
    expect(body.ok).toBe(true)
    expect(body.messages).toHaveLength(1)
  })

  test('base64 왕복이 봉투를 보존한다', async () => {
    const h = handler()
    const wire = await envelopeFor('바이너리 보존')
    await post(h, wire)
    const body = (await (await get(h, `/fetch/${hex(bob.keyId)}`)).json()) as FetchBody
    expect(fromBase64(body.messages[0]!.envelope)).toEqual(wire)
  })

  test('HTTP 를 지나도 수신자가 읽는다', async () => {
    const h = handler()
    await post(h, await envelopeFor('끝까지 왕복'))
    const body = (await (await get(h, `/fetch/${hex(bob.keyId)}`)).json()) as FetchBody

    const out = await receive({
      wire: fromBase64(body.messages[0]!.envelope),
      recipient: bob,
      guard: new ReplayGuard(),
      lookupSender: () => alice.signPublicKey,
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(dec.decode(out.plaintext)).toBe('끝까지 왕복')
  })

  test('빈 수신함은 빈 목록이다', async () => {
    const body = (await (await get(handler(), `/fetch/${hex(bob.keyId)}`)).json()) as FetchBody
    expect(body).toMatchObject({ ok: true, messages: [] })
  })

  test('꺼내면 비워진다', async () => {
    const h = handler()
    await post(h, await envelopeFor('한 번만'))
    const drain = async () =>
      ((await (await get(h, `/fetch/${hex(bob.keyId)}`)).json()) as FetchBody).messages
    expect(await drain()).toHaveLength(1)
    expect(await drain()).toHaveLength(0)
  })

  test('key id 형태가 아니면 400 이다', async () => {
    for (const bad of ['짧다', 'zzzz', 'abc']) {
      const res = await get(handler(), `/fetch/${encodeURIComponent(bad)}`)
      expect(res.status).toBe(400)
    }
  })
})

describe('그 외 경로', () => {
  test('health 가 응답한다', async () => {
    const res = await get(handler(), '/health')
    expect(res.status).toBe(200)
    expect((await res.json()) as HealthBody).toMatchObject({ ok: true })
  })

  test('모르는 경로는 404 다', async () => {
    expect((await get(handler(), '/없는길')).status).toBe(404)
  })

  test('메서드가 다르면 404 다', async () => {
    const h = handler()
    expect((await h(new Request('http://relay/post'))).status).toBe(404)
  })

  test('끝 슬래시를 무시한다', async () => {
    expect((await get(handler(), '/health/')).status).toBe(200)
  })
})
