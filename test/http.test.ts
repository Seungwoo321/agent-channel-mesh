/**
 * 릴레이 HTTP 테스트
 *
 * HTTP 계층이 얇다는 것을 확인하는 자리다 — 상태 코드와 직렬화만 본다.
 * 라우팅 로직은 relay.test.ts 가 이미 덮는다.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { createIdentity, sign, type Identity } from '../src/identity/keys.js'
import { seal } from '../src/crypto/seal.js'
import { encode } from '../src/crypto/envelope.js'
import { MemoryStore } from '../src/relay/store.js'
import {
  createHandler,
  fromBase64,
  type PostBody,
  type FetchBody,
  type ErrorBody,
  type HealthBody,
} from '../src/relay/http.js'
import { MAX_ENVELOPE_BYTES } from '../src/relay/relay.js'
import {
  fetchAuthHeaders,
  fetchSigningBytes,
  newFetchNonce,
  FETCH_WINDOW_MS,
} from '../src/relay/fetch-auth.js'
import { receive } from '../src/crypto/receive.js'
import { ReplayGuard } from '../src/crypto/replay.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const TAG = new Uint8Array(16).fill(0xab)

let alice: Identity
let bob: Identity
/** 자기 큐가 아닌 곳을 노리는 쪽. §10.12 의 공격자 자리다. */
let mallory: Identity

beforeAll(async () => {
  ;[alice, bob, mallory] = await Promise.all([
    createIdentity(),
    createIdentity(),
    createIdentity(),
  ])
})

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')

const handler = () => createHandler({ store: new MemoryStore() })

async function envelopeFor(text: string, seq = 1n) {
  return encode(
    await seal({
      sender: alice,
      recipients: [{ kemPublicKey: bob.kemPublicKey, signPublicKey: bob.signPublicKey }],
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

/**
 * 인증된 조회 요청 하나. 기본은 "주인이 자기 큐를 정상적으로 부른다" 이고,
 * 필드를 하나씩 갈아 끼워 §10.12 의 실패 형태를 만든다.
 *
 * 릴레이가 쓰는 것과 같은 `fetchSigningBytes` 로 서명한다 — 테스트가 서명
 * 대상을 따로 조립하면 진짜 불일치를 테스트 버그로 착각하게 된다.
 */
function authedRequest(
  signer: Identity,
  over: {
    /** 경로에 실을 key id. 기본은 서명자 자신의 것. */
    readonly pathKeyId?: string
    /** 헤더에 실을 KEM 공개키. 기본은 서명자 자신의 것. */
    readonly kemPublicKey?: Uint8Array
    /** 서명 대상에 넣을 key id. 기본은 서명자 자신의 것. */
    readonly signedKeyId?: Uint8Array
    readonly timeMs?: number
  } = {},
): Request {
  const nonce = newFetchNonce()
  const timeMs = over.timeMs ?? Date.now()
  const message = fetchSigningBytes(over.signedKeyId ?? signer.keyId, timeMs, nonce)
  const headers = fetchAuthHeaders({
    kemPublicKey: over.kemPublicKey ?? signer.kemPublicKey,
    signPublicKey: signer.signPublicKey,
    signature: sign(signer, message),
    timeMs,
    nonce,
  })
  return new Request(`http://relay/fetch/${over.pathKeyId ?? hex(signer.keyId)}`, { headers })
}

/** 주인이 자기 수신함을 정상적으로 비운다. */
const drainAs = (h: ReturnType<typeof handler>, who: Identity) => h(authedRequest(who))

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
    const res = await drainAs(h, bob)
    expect(res.status).toBe(200)
    const body = (await res.json()) as FetchBody
    expect(body.ok).toBe(true)
    expect(body.messages).toHaveLength(1)
  })

  test('base64 왕복이 봉투를 보존한다', async () => {
    const h = handler()
    const wire = await envelopeFor('바이너리 보존')
    await post(h, wire)
    const body = (await (await drainAs(h, bob)).json()) as FetchBody
    expect(fromBase64(body.messages[0]!.envelope)).toEqual(wire)
  })

  test('HTTP 를 지나도 수신자가 읽는다', async () => {
    const h = handler()
    await post(h, await envelopeFor('끝까지 왕복'))
    const body = (await (await drainAs(h, bob)).json()) as FetchBody

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
    const body = (await (await drainAs(handler(), bob)).json()) as FetchBody
    expect(body).toMatchObject({ ok: true, messages: [] })
  })

  test('꺼내면 비워진다', async () => {
    const h = handler()
    await post(h, await envelopeFor('한 번만'))
    const drain = async () => ((await (await drainAs(h, bob)).json()) as FetchBody).messages
    expect(await drain()).toHaveLength(1)
    expect(await drain()).toHaveLength(0)
  })

  test('key id 형태가 아니면 400 이다 — 인증 헤더 유무와 무관하다', async () => {
    for (const bad of ['짧다', 'zzzz', 'abc']) {
      const path = `/fetch/${encodeURIComponent(bad)}`
      expect((await get(handler(), path)).status).toBe(400)
      // 헤더를 제대로 붙여도 400 이다 — 형태 검사가 인증보다 앞이라,
      // 인증 실패(401)와 잘못 만든 요청(400)이 섞이지 않는다.
      const authed = await handler()(
        new Request(`http://relay${path}`, { headers: [...authedRequest(bob).headers] }),
      )
      expect(authed.status).toBe(400)
      expect((await authed.json()) as ErrorBody).toMatchObject({ reason: 'bad-key-id' })
    }
  })
})

describe('GET /fetch 인증 강제 (§10.12)', () => {
  test('인증 헤더가 없으면 401 이다', async () => {
    const res = await get(handler(), `/fetch/${hex(bob.keyId)}`)
    expect(res.status).toBe(401)
    expect((await res.json()) as ErrorBody).toMatchObject({ ok: false, reason: 'missing-auth' })
  })

  test('남의 key id 경로에 자기 서명을 붙이면 401 이다', async () => {
    const res = await handler()(authedRequest(mallory, { pathKeyId: hex(bob.keyId) }))
    expect(res.status).toBe(401)
    expect((await res.json()) as ErrorBody).toMatchObject({ reason: 'key-id-mismatch' })
  })

  test('피해자 KEM 키에 공격자 서명키를 붙여도 401 이다', async () => {
    // §10.12 의 핵심 공격이다. key id 가 **두 공개키** 에서 파생되므로,
    // 피해자의 KEM 키를 그대로 베껴 오고 서명만 자기 것으로 바꾸면
    // 파생 결과가 달라진다 — 릴레이는 아무것도 저장하지 않고 이것을 잡는다.
    const res = await handler()(
      authedRequest(mallory, {
        pathKeyId: hex(bob.keyId),
        kemPublicKey: bob.kemPublicKey,
        signedKeyId: bob.keyId,
      }),
    )
    expect(res.status).toBe(401)
    expect((await res.json()) as ErrorBody).toMatchObject({ reason: 'key-id-mismatch' })
  })

  test('창 밖 시각으로 서명하면 401 이다', async () => {
    const stale = Date.now() - FETCH_WINDOW_MS - 60_000
    const res = await handler()(authedRequest(bob, { timeMs: stale }))
    expect(res.status).toBe(401)
    expect((await res.json()) as ErrorBody).toMatchObject({ reason: 'stale-request' })
  })

  test('인증 실패는 큐를 비우지 않는다', async () => {
    // 이것이 §10.12 의 요점이다. 실패에 빈 배열을 주면 드레인이 이미 일어난
    // 뒤이므로, 주인은 "메시지가 없다"는 정상 응답을 받고 영영 못 받는다.
    const h = handler()
    await post(h, await envelopeFor('공격자가 훔쳐 갈 뻔한 것'))

    // 봉투가 들어 있는 **바로 그** 핸들러를 때려야 의미가 있다.
    expect((await h(authedRequest(mallory, { pathKeyId: hex(bob.keyId) }))).status).toBe(401)
    expect((await get(h, `/fetch/${hex(bob.keyId)}`)).status).toBe(401)
    expect((await h(authedRequest(bob, { timeMs: 0 }))).status).toBe(401)

    const body = (await (await drainAs(h, bob)).json()) as FetchBody
    expect(body.messages).toHaveLength(1)
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
