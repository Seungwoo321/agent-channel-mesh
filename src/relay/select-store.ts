/**
 * 저장소 선택 — 진입점이 어떤 `Store` 위에서 뜰지 정한다
 *
 * 설계 근거는 docs/architecture.md §10.7.
 *
 *   ACM_RELAY_STORE=memory   → 메모리 (로컬에서만)
 *   ACM_RELAY_STORE=turso    → Turso
 *   ACM_RELAY_STORE=upstash  → Upstash
 *
 * 선택값이 없을 때만 기존 배포와의 호환을 위해 자격증명을 자동 감지한다.
 * 자격증명이 하나면 그것을 쓰고, 둘 이상이면 어느 DB 를 쓸지 추측하지 않고
 * 명시적 선택을 요구한다.
 *
 * 서버리스 분기가 이 모듈의 존재 이유다. 서버리스 인스턴스는 요청마다 갈릴 수 있어
 * `MemoryStore` 위에서는 `POST /post` 를 받은 인스턴스와 `GET /fetch` 를
 * 받은 인스턴스가 달라지고, 봉투가 조용히 사라진다 — 릴레이는 200 을
 * 돌려주고 있으므로 아무도 고장을 눈치채지 못한다. 기동 때 크게 죽는 편이
 * 낫다.
 *
 * 진입점(`src/server.ts`)에서 떼어 낸 이유는 그 파일이 import 만으로
 * 서버를 띄우기 때문이다 — 거기 있으면 이 판단을 테스트에서 부를 수 없고,
 * 이 분기는 손으로만 확인할 수 있게 된다. 봉투 유실과 프로덕션 사이에
 * 서 있는 분기를 수동 검증에 맡기지 않는다.
 */
import { MemoryStore, type Store } from './store.js'
import { fromEnv as fromUpstashEnv, hasUpstashCredentials } from './upstash.js'
import {
  fromEnv as fromTursoEnv,
  hasAnyTursoCredentials,
  hasTursoCredentials,
  TursoStore,
} from './turso.js'

export type StoreProvider = 'memory' | 'turso' | 'upstash'

/** 저장소에 거는 상한. `ServeArgs` 가 구조적으로 이 모양을 만족한다. */
export interface StoreLimits {
  readonly ttlMs: number
  readonly maxQueue: number
}

export interface StoreSelection {
  readonly store: Store
  /** 실제로 선택된 저장소. 서버 로그와 진단이 같은 판정을 보여 주게 한다. */
  readonly provider: StoreProvider
  /**
   * 프로세스 밖 저장소인가 — 인스턴스 간 공유되는 외부 저장소에 실제로 닿는다.
   *
   * `/keepalive` 등록 여부가 여기 달렸다. 메모리 저장소 위에서 keepalive 는
   * 외부 저장소를 건드리지 않으면서 `ok:true` 를 돌려주므로, 연결 확인을
   * 했다는 착각만 만든다.
   */
  readonly durable: boolean
}

export function selectStore(env: Record<string, string | undefined>, limits: StoreLimits): StoreSelection {
  const requested = requestedProvider(env)
  if (requested !== undefined) return makeStore(requested, env, limits)

  // 자동 감지 단계에서 한쪽 자격만 들어온 경우를 "자격 없음"으로 취급하면
  // 오타가 로컬에서는 메모리 fallback 으로, 배포에서는 다른 DB 선택으로
  // 둔갑한다. 어느 환경에서도 잘못된 설정은 즉시 설명해야 한다.
  if (hasAnyTursoCredentials(env) && !hasTursoCredentials(env)) {
    throw new Error('Turso 자격이 불완전하다 — TURSO_DATABASE_URL 과 TURSO_AUTH_TOKEN 을 함께 설정한다.')
  }
  if (hasAnyUpstashCredentials(env) && !hasUpstashCredentials(env)) {
    throw new Error(
      'Upstash 자격이 불완전하다 — UPSTASH_REDIS_REST_URL 과 UPSTASH_REDIS_REST_TOKEN 을 함께 설정한다. ' +
        '(Vercel 통합의 KV_REST_API_URL/TOKEN 도 지원한다.)',
    )
  }

  const available: StoreProvider[] = []
  if (hasTursoCredentials(env)) available.push('turso')
  if (hasUpstashCredentials(env)) available.push('upstash')
  if (available.length > 1) {
    throw new Error(
      `저장소 자격이 둘 다 있다 (${available.join(', ')}) — 어느 DB 를 쓸지 ACM_RELAY_STORE=turso 또는 upstash 로 명시한다.`,
    )
  }
  if (available.length === 1) return makeStore(available[0]!, env, limits)

  if (env.VERCEL) {
    throw new Error(
      '서버리스에서 메모리 저장소로 뜨지 않는다 — 인스턴스마다 메모리가 갈려 봉투가 조용히 사라진다. ' +
        'ACM_RELAY_STORE=turso 와 TURSO_DATABASE_URL/TURSO_AUTH_TOKEN, 또는 ' +
        'ACM_RELAY_STORE=upstash 와 UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN 을 설정한다. ' +
        '(Vercel 통합이 KV_REST_API_URL/TOKEN 으로 넣었다면 그것도 읽는다.)',
    )
  }
  return makeStore('memory', env, limits)
}

function requestedProvider(env: Record<string, string | undefined>): StoreProvider | undefined {
  const raw = env.ACM_RELAY_STORE?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'memory' || raw === 'local') return 'memory'
  if (raw === 'turso' || raw === 'upstash') return raw
  throw new Error(`ACM_RELAY_STORE 값이 잘못됐다: '${raw}' — memory(local)·turso·upstash 중 하나를 쓴다.`)
}

function makeStore(
  provider: StoreProvider,
  env: Record<string, string | undefined>,
  limits: StoreLimits,
): StoreSelection {
  if (provider === 'memory') {
    if (env.VERCEL) {
      throw new Error(
        'ACM_RELAY_STORE=memory 는 서버리스에서 쓸 수 없다 — 로컬 릴레이에서만 선택한다. ' +
          '서버리스는 ACM_RELAY_STORE=turso 또는 ACM_RELAY_STORE=upstash 를 쓴다.',
      )
    }
    return {
      store: new MemoryStore({ ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }),
      provider,
      durable: false,
    }
  }
  if (provider === 'turso') {
    return {
      store: fromTursoEnv(env, { ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }),
      provider,
      durable: true,
    }
  }
  return {
    store: fromUpstashEnv(env, { ttlMs: limits.ttlMs, maxQueue: limits.maxQueue }),
    provider,
    durable: true,
  }
}

function hasAnyUpstashCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.UPSTASH_REDIS_REST_URL?.trim() ||
      env.UPSTASH_REDIS_REST_TOKEN?.trim() ||
      env.KV_REST_API_URL?.trim() ||
      env.KV_REST_API_TOKEN?.trim(),
  )
}
