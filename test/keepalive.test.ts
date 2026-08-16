/**
 * Cron keepalive 인증 테스트.
 *
 * Vercel 은 cron 요청에 인증을 자동으로 붙이지 않는다 — `CRON_SECRET` 을
 * 헤더로 실어 보낼 뿐이고 검증은 우리 몫이다. 그 검증이 빠지면 이 경로는
 * 누구나 부를 수 있게 되므로, 회귀를 막기 위해 테스트로 고정한다.
 *
 * 모듈이 `process.env` 를 import 시점이 아니라 요청 시점에 읽으므로
 * 테스트에서 환경을 바꿔 끼울 수 있다.
 *
 * 저장소는 주입한다 — 진입점이 고른 저장소를 받는 형태이므로, 인증이
 * 저장소보다 **먼저** 걸리는지를 "저장소를 건드리면 터지는 스텁"으로 본다.
 */
import { test, expect, afterEach } from 'bun:test'
import { keepalive } from '../src/relay/keepalive.js'
import type { Store, Stored } from '../src/relay/store.js'

const saved = { ...process.env }

afterEach(() => {
  process.env.CRON_SECRET = saved.CRON_SECRET
})

/** 어느 연산이든 부르면 터진다. 인증 전에 저장소에 닿지 않음을 고정한다. */
function failingStore(message: string): Store {
  return {
    push: async (): Promise<void> => {
      throw new Error(message)
    },
    drain: async (): Promise<Stored[]> => {
      throw new Error(message)
    },
    depth: async (): Promise<number> => {
      throw new Error(message)
    },
  }
}

function call(
  headers: Record<string, string> = {},
  store: Store = failingStore('저장소를 건드리면 안 된다'),
  method = 'GET',
) {
  return keepalive(new Request('https://relay.example/keepalive', { headers, method }), store)
}

test('GET 이 아니면 받지 않는다', async () => {
  process.env.CRON_SECRET = 'topsecret'
  // cron 은 GET 만 보낸다. 나머지 경로가 전부 메서드를 확인하므로 여기만
  // 아무 메서드나 받으면 릴레이의 규칙이 경로마다 갈린다.
  const res = await call({ authorization: 'Bearer topsecret' }, undefined, 'POST')
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
})

test('시크릿이 없으면 부르지 못한다', async () => {
  process.env.CRON_SECRET = 'topsecret'
  const res = await call()
  expect(res.status).toBe(401)
})

test('틀린 시크릿을 거부한다', async () => {
  process.env.CRON_SECRET = 'topsecret'
  const res = await call({ authorization: 'Bearer wrong' })
  expect(res.status).toBe(401)
})

test('Bearer 접두가 없으면 거부한다', async () => {
  process.env.CRON_SECRET = 'topsecret'
  const res = await call({ authorization: 'topsecret' })
  expect(res.status).toBe(401)
})

test('CRON_SECRET 이 설정 안 됐으면 열지 않고 죽는다', async () => {
  // 시크릿 없음 = 공개 엔드포인트가 아니라 오설정이다. 통과시키면
  // "인증이 있는 줄 알았는데 없는" 상태가 조용히 만들어진다.
  delete process.env.CRON_SECRET
  const res = await call({ authorization: 'Bearer anything' })
  expect(res.status).toBe(500)
  // 어떤 500 인지까지 못 박는다. 상태 코드와 `ok:false` 만 보면 저장소 먼저
  // 건드리고 실패한 구현도 이 테스트를 통과한다 — 그 구현은 시크릿 없이
  // 저장소에 닿는다.
  expect(await res.json()).toMatchObject({ ok: false, detail: expect.stringContaining('CRON_SECRET') })
})

test('올바른 시크릿이면 통과해 저장소까지 간다', async () => {
  process.env.CRON_SECRET = 'topsecret'
  // 저장소 실패를 200 으로 감추지 않는다 — 인증을 통과했다는 것은
  // 401 이 아닌, 저장소에서 온 실패로 확인된다. cron 실패가 보여야
  // 아카이브가 임박한 것을 눈치챌 수 있다.
  const res = await call({ authorization: 'Bearer topsecret' }, failingStore('UPSTASH_REDIS_REST_URL 이 비어 있다'))
  expect(res.status).toBe(500)
  expect(await res.text()).toContain('UPSTASH_REDIS_REST_URL')
})
