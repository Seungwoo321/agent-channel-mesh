/**
 * 저장소 선택 — 진입점이 어떤 `Store` 위에서 뜰지 정한다
 *
 * 설계 근거는 docs/architecture.md §10.7.
 *
 *   자격 있음                → Upstash
 *   자격 없음 + 로컬         → 메모리 (설정 없이 바로 띄울 수 있어야 한다)
 *   자격 없음 + 서버리스     → 던진다
 *
 * 셋째가 이 모듈의 존재 이유다. 서버리스 인스턴스는 요청마다 갈릴 수 있어
 * `MemoryStore` 위에서는 `POST /post` 를 받은 인스턴스와 `GET /fetch` 를
 * 받은 인스턴스가 달라지고, 봉투가 조용히 사라진다 — 릴레이는 200 을
 * 돌려주고 있으므로 아무도 고장을 눈치채지 못한다. 기동 때 크게 죽는 편이
 * 낫다.
 *
 * 진입점(`src/server.ts`)에서 떼어 낸 이유는 그 파일이 import 만으로
 * 서버를 띄우기 때문이다 — 거기 있으면 이 판단을 테스트에서 부를 수 없고,
 * 위 셋째 분기는 손으로만 확인할 수 있게 된다. 봉투 유실과 프로덕션 사이에
 * 서 있는 분기를 수동 검증에 맡기지 않는다.
 */
import { MemoryStore, type Store } from './store.js'
import { fromEnv, hasUpstashCredentials } from './upstash.js'

/** 저장소에 거는 상한. `ServeArgs` 가 구조적으로 이 모양을 만족한다. */
export interface StoreLimits {
  readonly ttlMs: number
  readonly maxQueue: number
}

export interface StoreSelection {
  readonly store: Store
  /**
   * 프로세스 밖 저장소인가 — 인스턴스 간 공유되고 Redis 에 실제로 닿는다.
   *
   * `/keepalive` 등록 여부가 여기 달렸다. 메모리 저장소 위에서 keepalive 는
   * Redis 를 건드리지 않으면서 `ok:true` 를 돌려주므로, 아카이브를 막고
   * 있다는 착각만 만든다.
   */
  readonly durable: boolean
}

export function selectStore(env: Record<string, string | undefined>, limits: StoreLimits): StoreSelection {
  if (hasUpstashCredentials(env)) {
    return { store: fromEnv(env, { ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }), durable: true }
  }
  if (env.VERCEL) {
    throw new Error(
      '서버리스에서 메모리 저장소로 뜨지 않는다 — 인스턴스마다 메모리가 갈려 봉투가 조용히 사라진다. ' +
        'UPSTASH_REDIS_REST_URL 과 UPSTASH_REDIS_REST_TOKEN 을 설정한다. ' +
        '(Vercel 통합이 KV_REST_API_URL/TOKEN 으로 넣었다면 그것도 읽는다.)',
    )
  }
  return { store: new MemoryStore({ ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }), durable: false }
}
