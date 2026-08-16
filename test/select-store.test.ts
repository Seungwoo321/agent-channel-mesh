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

const limits = { ttlMs: DEFAULT_TTL_MS, maxQueue: DEFAULT_MAX_QUEUE }

const credentials = {
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token',
}

describe('저장소 선택', () => {
  test('자격이 있으면 Upstash 다', () => {
    const selection = selectStore(credentials, limits)
    expect(selection.store).toBeInstanceOf(UpstashStore)
    expect(selection.durable).toBe(true)
  })

  test('자격이 있으면 서버리스에서도 Upstash 다', () => {
    const selection = selectStore({ ...credentials, VERCEL: '1' }, limits)
    expect(selection.store).toBeInstanceOf(UpstashStore)
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

  test('자격이 없고 로컬이면 메모리다 — 설정 없이 띄울 수 있어야 한다', () => {
    const selection = selectStore({}, limits)
    expect(selection.store).toBeInstanceOf(MemoryStore)
    expect(selection.durable).toBe(false)
  })

  test('자격이 없고 서버리스면 던진다', () => {
    // 인스턴스마다 메모리가 갈려 봉투가 조용히 사라진다. 200 을 돌려주면서
    // 메시지를 버리는 릴레이보다 기동 실패가 낫다.
    expect(() => selectStore({ VERCEL: '1' }, limits)).toThrow(/UPSTASH_REDIS_REST_URL/)
  })

  test('토큰만 있고 URL 이 없으면 자격으로 치지 않는다', () => {
    expect(() => selectStore({ UPSTASH_REDIS_REST_TOKEN: 'token', VERCEL: '1' }, limits)).toThrow()
  })
})
