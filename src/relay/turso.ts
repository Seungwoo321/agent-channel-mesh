/**
 * Turso 저장소 — 서버리스 배포용 `Store` 구현
 *
 * 이 테이블은 대화 기록이 아니다. 릴레이가 수신자를 기다리는 동안만
 * 암호화된 봉투를 보관하고, `drain` 이 성공하면 같은 원자적 배치 안에서
 * 반환과 삭제를 끝낸다. 남은 항목은 TTL 과 큐 상한으로 제거된다.
 *
 * Turso 의 서버리스 드라이버는 fetch 만 사용하므로 Bun·Vercel·Edge 런타임에
 * 같은 어댑터를 올릴 수 있다. 모든 변경 배치는 `immediate` 모드로 보내
 * 스키마 준비·삽입·정리·drain 의 중간 상태가 외부에 보이지 않게 한다.
 */
import { connect, type BatchStatement, type Connection } from '@tursodatabase/serverless'
import type { Store, Stored } from './store.js'
import { DEFAULT_MAX_QUEUE, DEFAULT_TTL_MS } from './store.js'

const TABLE = 'acm_relay_queue'
const INDEX = 'acm_relay_queue_recipient_idx'

/** 테스트에서 네트워크 없는 클라이언트를 주입할 수 있게 한 최소 표면. */
export type TursoClient = Pick<Connection, 'batch'>

export interface TursoStoreOptions {
  /** `TURSO_DATABASE_URL`. */
  readonly url: string
  /** `TURSO_AUTH_TOKEN`. */
  readonly token: string
  readonly ttlMs?: number
  /** 수신자당 큐 상한. 무한 적재를 막는다. */
  readonly maxQueue?: number
  /** 같은 Turso DB 를 여러 릴레이가 공유할 때의 논리적 네임스페이스. */
  readonly namespace?: string
  /** 테스트에서 시각을 주입한다. */
  readonly now?: () => number
  /** 테스트용 클라이언트. 생략하면 공식 fetch 기반 드라이버를 만든다. */
  readonly client?: TursoClient
}

export class TursoError extends Error {
  override readonly cause?: unknown

  constructor(
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'TursoError'
    this.cause = cause
  }
}

interface BatchResult {
  readonly rows?: unknown
}

/**
 * Turso 큐 저장소.
 *
 * 행의 `envelope` 는 BLOB 이지만 릴레이는 그것을 해석하지 않는다. `id` 가
 * FIFO 순서를 정하고 `expires_at` 이 보관 기간을 정한다. 스키마는 첫 요청에
 * 지연 생성하므로 모듈 import 나 생성자 호출만으로 원격 DB 를 쓰지 않는다.
 */
export class TursoStore implements Store {
  private readonly client: TursoClient
  private readonly ttlMs: number
  private readonly maxQueue: number
  private readonly namespace: string
  private readonly now: () => number
  private schemaReady: Promise<void> | undefined

  constructor(options: TursoStoreOptions) {
    if (!options.url?.trim()) throw new TursoError('TURSO_DATABASE_URL 이 비어 있다')
    if (!options.token?.trim()) throw new TursoError('TURSO_AUTH_TOKEN 이 비어 있다')

    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TursoError('ttlMs 는 양수여야 한다')
    if (!Number.isInteger(maxQueue) || maxQueue <= 0) throw new TursoError('maxQueue 는 양의 정수여야 한다')

    const namespace = options.namespace?.trim() || 'default'
    this.client = options.client ?? connect({ url: options.url.trim(), authToken: options.token.trim() })
    this.ttlMs = ttlMs
    this.maxQueue = maxQueue
    this.namespace = namespace
    this.now = options.now ?? Date.now
  }

  async push(recipient: string, item: Stored): Promise<void> {
    const receivedAt = finiteNumber(item.receivedAt, 'receivedAt')
    const expiresAt = receivedAt + this.ttlMs
    await this.atomic([
      {
        sql: `DELETE FROM ${TABLE} WHERE namespace = ? AND expires_at <= ?`,
        args: [this.namespace, this.now()],
      },
      {
        sql: `INSERT INTO ${TABLE} (namespace, recipient, received_at, expires_at, envelope)
              VALUES (?, ?, ?, ?, ?)`,
        args: [this.namespace, recipient, receivedAt, expiresAt, item.envelope],
      },
      {
        // 새 항목을 넣은 뒤 각 수신자의 최신 maxQueue 개만 남긴다.
        sql: `DELETE FROM ${TABLE}
              WHERE namespace = ? AND recipient = ?
                AND id NOT IN (
                  SELECT id FROM ${TABLE}
                   WHERE namespace = ? AND recipient = ?
                   ORDER BY id DESC
                   LIMIT ?
                )`,
        args: [this.namespace, recipient, this.namespace, recipient, this.maxQueue],
      },
    ])
  }

  async drain(recipient: string, limit: number): Promise<Stored[]> {
    const count = integerLimit(limit)
    if (count <= 0) return []
    const now = this.now()

    // DELETE ... RETURNING 을 사용한다. SELECT 후 DELETE 를 따로 보내면 두
    // 요청 사이에 다른 수신자가 같은 큐를 건드릴 수 있어 중복·유실이 생긴다.
    const results = await this.atomic([
      {
        sql: `DELETE FROM ${TABLE} WHERE namespace = ? AND expires_at <= ?`,
        args: [this.namespace, now],
      },
      {
        sql: `DELETE FROM ${TABLE}
              WHERE id IN (
                SELECT id FROM ${TABLE}
                 WHERE namespace = ? AND recipient = ? AND expires_at > ?
                 ORDER BY id ASC
                 LIMIT ?
              )
              RETURNING received_at, envelope`,
        args: [this.namespace, recipient, now, count],
      },
    ])

    return rowsOf(results[1], 'drain').map(row => ({
      receivedAt: finiteNumber(row.received_at, 'received_at'),
      envelope: bytes(row.envelope),
    }))
  }

  async depth(recipient: string): Promise<number> {
    const now = this.now()
    const results = await this.atomic([
      {
        sql: `DELETE FROM ${TABLE} WHERE namespace = ? AND expires_at <= ?`,
        args: [this.namespace, now],
      },
      {
        sql: `SELECT COUNT(*) AS count FROM ${TABLE}
               WHERE namespace = ? AND recipient = ? AND expires_at > ?`,
        args: [this.namespace, recipient, now],
      },
    ])
    const row = rowsOf(results[1], 'depth')[0]
    return row === undefined ? 0 : finiteNumber(row.count, 'count')
  }

  private async atomic(statements: BatchStatement[]): Promise<readonly BatchResult[]> {
    await this.ensureSchema()
    try {
      return (await this.client.batch(statements, 'immediate')) as readonly BatchResult[]
    } catch (e) {
      throw wrap('원자적 배치', e)
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady !== undefined) return await this.schemaReady

    const work = this.client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS ${TABLE} (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             namespace TEXT NOT NULL,
             recipient TEXT NOT NULL,
             received_at INTEGER NOT NULL,
             expires_at INTEGER NOT NULL,
             envelope BLOB NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS ${INDEX}
             ON ${TABLE} (namespace, recipient, id)`,
        ],
        'immediate',
      )
      .then(() => undefined)

    this.schemaReady = work.catch(e => {
      this.schemaReady = undefined
      throw wrap('스키마 준비', e)
    })
    return await this.schemaReady
  }
}

/** 환경변수로 Turso 저장소를 만든다. 자격이 없으면 모호하게 메모리로 내리지 않는다. */
export function fromEnv(
  env: Record<string, string | undefined>,
  options: Omit<Partial<TursoStoreOptions>, 'url' | 'token'> = {},
): TursoStore {
  const url = env.TURSO_DATABASE_URL?.trim()
  const token = env.TURSO_AUTH_TOKEN?.trim()
  if (!url || !token) {
    throw new TursoError('Turso 자격이 없다 — TURSO_DATABASE_URL 과 TURSO_AUTH_TOKEN 을 설정한다.')
  }
  return new TursoStore({ ...options, url, token })
}

/** 두 Turso 자격이 모두 있는지만 본다. */
export function hasTursoCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.TURSO_DATABASE_URL?.trim() && env.TURSO_AUTH_TOKEN?.trim())
}

/** 한쪽만 설정된 오타도 자동 선택 단계에서 감지하기 위한 검사. */
export function hasAnyTursoCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.TURSO_DATABASE_URL?.trim() || env.TURSO_AUTH_TOKEN?.trim())
}

function rowsOf(result: BatchResult | undefined, action: string): Record<string, unknown>[] {
  if (result === undefined || !Array.isArray(result.rows)) {
    throw new TursoError(`Turso ${action} 응답에 행 목록이 없다`)
  }
  return result.rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new TursoError(`Turso ${label} 이 숫자가 아니다`)
  }
  return number
}

function integerLimit(value: number): number {
  if (!Number.isFinite(value)) throw new TursoError('drain limit 이 유한한 숫자가 아니다')
  return Math.max(0, Math.floor(value))
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  throw new TursoError(`Turso envelope 이 BLOB 이 아니다: ${typeof value}`)
}

function wrap(action: string, cause: unknown): TursoError {
  if (cause instanceof TursoError) return cause
  return new TursoError(`Turso ${action} 실패: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
}
