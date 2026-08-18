/**
 * 릴레이 쓰기 인증 테스트 (§10.13)
 *
 * 여기서 지키는 것은 셋이다 — 토큰 없는 쓰기가 **저장소에 닿기 전에** 막히는
 * 것, 인증 없이 공개 주소에 뜨지 못하는 것, 그리고 토큰 비교가 내용에 따라
 * 시간이 갈리지 않는 것.
 *
 * 첫째가 이 파일의 이유다. 큐는 상한에서 가장 오래된 것부터 버리므로, 아무나
 * 쓸 수 있으면 남의 수신함을 채우는 것만으로 아직 못 받은 봉투를 밀어낼 수
 * 있다 — 당한 쪽에서는 그 유실이 보이지 않는다.
 */
import { test, expect, describe } from 'bun:test'
import {
  parseBearer,
  verifyPostAuth,
  selectPostAuth,
  isLoopback,
  MIN_TOKEN_CHARS,
  HEADER_POST_AUTH,
  type PostAuth,
} from '../src/relay/post-auth.js'
import { createHandler } from '../src/relay/http.js'
import { MemoryStore } from '../src/relay/store.js'

/** 최소 길이를 넘는 토큰. 실제 사용법(`openssl rand -hex 32`)과 같은 모양이다. */
const TOKEN = 'a'.repeat(MIN_TOKEN_CHARS + 8)

const headers = (value?: string) => new Headers(value === undefined ? {} : { [HEADER_POST_AUTH]: value })

describe('헤더 읽기', () => {
  test('Bearer 토큰을 꺼낸다', () => {
    expect(parseBearer(headers(`Bearer ${TOKEN}`))).toBe(TOKEN)
  })

  test('방식 이름의 대소문자를 가리지 않는다 — HTTP 가 그렇다', () => {
    expect(parseBearer(headers(`bearer ${TOKEN}`))).toBe(TOKEN)
  })

  test('헤더가 없으면 undefined', () => {
    expect(parseBearer(headers())).toBeUndefined()
  })

  test('다른 인증 방식은 토큰으로 읽지 않는다', () => {
    // Basic 을 Bearer 로 오독하면 base64 사용자:비밀번호가 토큰 자리에 들어간다.
    expect(parseBearer(headers('Basic dXNlcjpwdw=='))).toBeUndefined()
  })

  test('방식 없이 값만 온 것도 받지 않는다', () => {
    expect(parseBearer(headers(TOKEN))).toBeUndefined()
  })
})

describe('검사', () => {
  const auth: PostAuth = { token: TOKEN }

  test('맞는 토큰은 통과한다', () => {
    expect(verifyPostAuth(auth, headers(`Bearer ${TOKEN}`))).toEqual({ ok: true })
  })

  test('없으면 missing-auth', () => {
    const r = verifyPostAuth(auth, headers())
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('missing-auth')
  })

  test('틀리면 bad-token', () => {
    const r = verifyPostAuth(auth, headers(`Bearer ${'b'.repeat(MIN_TOKEN_CHARS + 8)}`))
    expect(r.ok === false && r.reason).toBe('bad-token')
  })

  test('접두만 맞는 것으로는 통과하지 못한다', () => {
    // 앞에서부터 견주다 첫 불일치에서 끝내는 비교는 시간으로 정답을 흘린다.
    // 여기서 보는 것은 그 시간이 아니라 **결과** — 접두 일치를 통과로 치지 않는가.
    const r = verifyPostAuth(auth, headers(`Bearer ${TOKEN.slice(0, -1)}`))
    expect(r.ok).toBe(false)
  })

  test('열려 있으면 헤더가 없어도 통과한다', () => {
    expect(verifyPostAuth({ open: true }, headers())).toEqual({ ok: true })
  })

  test('열려 있으면 엉뚱한 토큰이 붙어 있어도 막지 않는다', () => {
    // 열림은 "토큰을 보지 않는다" 는 뜻이다. 여기서 반쯤 검사하면 정책이 둘이 된다.
    // 헤더 값은 ASCII 여야 한다 — 한글을 넣으면 Headers 가 먼저 던져서
    // 우리 코드가 무엇을 하는지 보지 못한 채 테스트가 끝난다.
    expect(verifyPostAuth({ open: true }, headers('Bearer whatever'))).toEqual({ ok: true })
  })
})

describe('비교 시간이 내용에 의존하지 않는다', () => {
  test('맞는 토큰과 완전히 다른 토큰의 검사 시간이 비슷하다', () => {
    // 통계적 보장을 주장하지 않는다 — 이 테스트가 잡는 것은 `===` 나 앞에서부터
    // 끊는 비교로 되돌아가는 회귀다. 그런 구현은 길이가 다른 순간 즉시 끝나
    // 배수 차이가 난다.
    const auth: PostAuth = { token: TOKEN }
    const near = `Bearer ${TOKEN.slice(0, -1)}x`
    const far = 'Bearer x'
    const rounds = 2000

    // **최솟값**을 본다. 평균은 다른 테스트가 같이 도는 동안의 스케줄러
    // 방해를 그대로 흡수해 실패가 무작위로 나고, 그런 테스트는 없는 것보다
    // 나쁘다 — 아무도 그 빨간불을 믿지 않게 된다. 최솟값은 "방해가 가장
    // 적었던 회차"라 그 잡음에 훨씬 덜 흔들린다.
    const measure = (value: string) => {
      const h = headers(value)
      let best = Infinity
      for (let attempt = 0; attempt < 7; attempt++) {
        const t0 = Bun.nanoseconds()
        for (let i = 0; i < rounds; i++) verifyPostAuth(auth, h)
        best = Math.min(best, Bun.nanoseconds() - t0)
      }
      return best
    }
    // 워밍업 — JIT 가 덜 데워진 첫 회차가 느려서 생기는 착시를 없앤다.
    measure(near)
    measure(far)

    const a = measure(near)
    const b = measure(far)
    const ratio = Math.max(a, b) / Math.min(a, b)
    // 문턱이 헐거운 것은 의도다. 잡는 대상은 미세한 누출이 아니라 `===` 로
    // 되돌아가는 회귀이고, 그건 배수로 벌어진다.
    expect(ratio).toBeLessThan(4)
  })
})

describe('정책 선택', () => {
  const local = { serverless: false, host: '127.0.0.1' }

  test('토큰이 있으면 강제한다', () => {
    expect(selectPostAuth({ ACM_RELAY_TOKEN: TOKEN }, local)).toEqual({ token: TOKEN })
  })

  test('토큰 없이 루프백이면 열린다 — 이 기계 밖에서 닿지 못한다', () => {
    expect(selectPostAuth({}, local)).toEqual({ open: true })
  })

  test('토큰 없이 공개 주소면 던진다', () => {
    // 조용히 열린 채로 뜨면 그 순간부터 누구나 남의 큐를 밀어낼 수 있고,
    // 아무 로그도 남지 않는다. 기동에서 죽는 편이 낫다.
    expect(() => selectPostAuth({}, { serverless: false, host: '0.0.0.0' })).toThrow(
      /ACM_RELAY_TOKEN/,
    )
  })

  test('토큰 없이 서버리스면 던진다 — 주소를 우리가 정하지 못한다', () => {
    expect(() => selectPostAuth({}, { serverless: true, host: '127.0.0.1' })).toThrow(
      /ACM_RELAY_TOKEN/,
    )
  })

  test('빈 값·공백은 없는 것으로 본다', () => {
    // 셸이 `ACM_RELAY_TOKEN=` 를 흘려보내면 빈 문자열이 온다. 그걸 토큰으로
    // 받으면 빈 Bearer 하나로 통과하는 릴레이가 된다.
    expect(() => selectPostAuth({ ACM_RELAY_TOKEN: '   ' }, { serverless: true, host: 'x' })).toThrow(
      /ACM_RELAY_TOKEN/,
    )
  })

  test('짧은 토큰은 거부한다 — 인증이 있다는 착각만 준다', () => {
    expect(() => selectPostAuth({ ACM_RELAY_TOKEN: 'short' }, local)).toThrow(/짧다/)
  })

  test('앞뒤 공백은 털어 낸다 — .env 한 줄이 개행을 데려온다', () => {
    expect(selectPostAuth({ ACM_RELAY_TOKEN: ` ${TOKEN}\n` }, local)).toEqual({ token: TOKEN })
  })
})

describe('루프백 판정', () => {
  test.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    '%s 는 루프백이다',
    host => expect(isLoopback(host)).toBe(true),
  )

  test.each(['0.0.0.0', '::', '192.168.0.5', '10.0.0.1', 'relay.example.com', '127.0.0.1.evil.com'])(
    '%s 는 루프백이 아니다',
    host => expect(isLoopback(host)).toBe(false),
  )
})

describe('HTTP 경로', () => {
  const envelope = new Uint8Array([1, 2, 3])
  const post = (handle: (r: Request) => Promise<Response>, init: RequestInit = {}) =>
    handle(new Request('http://relay/post', { method: 'POST', body: envelope, ...init }))

  test('토큰이 없으면 401 이다', async () => {
    const handle = createHandler({ store: new MemoryStore(), postAuth: { token: TOKEN } })
    const res = await post(handle)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, reason: 'missing-auth' })
  })

  test('토큰이 틀리면 401 이다', async () => {
    const handle = createHandler({ store: new MemoryStore(), postAuth: { token: TOKEN } })
    const res = await post(handle, { headers: { [HEADER_POST_AUTH]: 'Bearer wrong-token' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'bad-token' })
  })

  test('막힌 요청은 본문을 읽지도 않는다', async () => {
    // 인증을 본문 뒤에 두면 그 앞 단계(최대 1MB 를 메모리로 끌어오는 일)가
    // 통째로 무료 공격면이 된다. 몸통을 읽으려는 **호출 자체**가 없어야 한다.
    //
    // 스트림이 당겨졌는지로는 이걸 볼 수 없다 — Request 를 만드는 순간 런타임이
    // 이미 몸통을 빨아들여, 우리 핸들러가 무엇을 했든 항상 "읽혔음"이 나온다.
    // 그래서 우리가 부르는 지점(`arrayBuffer`)을 직접 지켜본다.
    let read = false
    const req = new Request('http://relay/post', { method: 'POST', body: envelope })
    const watched = new Proxy(req, {
      get(target, prop) {
        if (prop === 'arrayBuffer') {
          read = true
          return () => target.arrayBuffer()
        }
        // receiver 를 넘기면 `url` 같은 네이티브 getter 가 프록시를 this 로
        // 받아 죽는다 — 원본에서 그대로 읽어 온다.
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const handle = createHandler({ store: new MemoryStore(), postAuth: { token: TOKEN } })
    const res = await handle(watched)
    expect(res.status).toBe(401)
    expect(read).toBe(false)
  })

  test('막힌 요청은 저장소를 건드리지 않는다', async () => {
    const store = new MemoryStore()
    let touched = false
    const spy = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'push' || prop === 'drain') touched = true
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const handle = createHandler({ store: spy, postAuth: { token: TOKEN } })
    await post(handle)
    expect(touched).toBe(false)
  })

  test('맞는 토큰이면 평소대로 처리한다', async () => {
    // 인증을 통과한 뒤에는 형식 검사가 그대로 돈다 — 3바이트는 봉투가 아니다.
    const handle = createHandler({ store: new MemoryStore(), postAuth: { token: TOKEN } })
    const res = await post(handle, { headers: { [HEADER_POST_AUTH]: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false })
  })

  test('쓰기 인증은 조회 인증을 대신하지 않는다', async () => {
    // 토큰 하나로 남의 수신함까지 비울 수 있으면 §10.12 가 무너진다.
    // 두 문은 서로 다른 질문에 답한다.
    const handle = createHandler({ store: new MemoryStore(), postAuth: { open: true } })
    const res = await handle(
      new Request('http://relay/fetch/00112233445566aa', {
        headers: { [HEADER_POST_AUTH]: `Bearer ${TOKEN}` },
      }),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'missing-auth' })
  })
})
