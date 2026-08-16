/**
 * 로컬 저장소 테스트
 *
 * 여기서 지키는 것은 §6.3 의 세 방어다 — 평문이 넓은 권한으로 읽히지 않는 것,
 * 보관 기한이 표시가 아니라 실제 삭제인 것, purge 가 파일을 없애는 것.
 * 그리고 §6.4 의 축과 §6.6 의 전달 상태가 저장 시점에 박히는 것.
 *
 * 디스크를 **직접** 확인한다. 저장소가 걸러서 보여주는 것만 보면 "표시만 지우고
 * 파일에 남기는" 구현도 전부 통과한다 — 그건 이 파일이 막으려는 바로 그것이다.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageStore,
  DEFAULT_RETENTION_MS,
  type NewMessage,
  type StoredMessage,
} from '../src/store/store.js'

/** 홈의 실제 저장소를 절대 건드리지 않는다 — 테스트마다 임시 디렉토리를 판다. */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acm-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const A = 'aa11'
const B = 'bb22'

function inbound(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    channelId: A,
    direction: 'in',
    axis: 'external',
    senderKeyId: 'deadbeef',
    senderLabel: 'bob',
    text: '안녕',
    sentAt: 1_000,
    ...overrides,
  }
}

/** 저장소를 거치지 않고 파일 원문을 본다. "실제로 지워졌는가"의 유일한 증거다. */
async function rawMessages(path: string): Promise<StoredMessage[]> {
  return JSON.parse(await readFile(path, 'utf8')).messages
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}

describe('권한 (§6.3 · §11 과 같은 기준)', () => {
  // SCN-1
  test('0644 인 저장 파일은 읽지 않고 던진다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    await chmod(store.pathOf(A), 0o644)
    await expect(store.read(A)).rejects.toThrow(/권한이 너무 넓다/)
  })

  test('넓은 권한 파일은 쓰기 경로에서도 막힌다 — 우회 경로를 남기지 않는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    await chmod(store.pathOf(A), 0o606)
    await expect(store.append(inbound({ text: '두 번째' }))).rejects.toThrow(/권한이 너무 넓다/)
  })

  test('저장 디렉토리가 넓으면 던진다 — 목록만 새도 채널 id 가 샌다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    await chmod(dir, 0o755)
    await expect(store.append(inbound())).rejects.toThrow(/저장 디렉토리 권한이 너무 넓다/)
    await chmod(dir, 0o700)
  })

  test('넓은 디렉토리는 읽기 경로에서도 막힌다 — 파일만 검사하면 방어가 절반이다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    // 파일은 0600 그대로다. 그래도 디렉토리가 열려 있으면 평문은 이미 노출돼 있다.
    await chmod(dir, 0o755)
    await expect(store.read(A)).rejects.toThrow(/저장 디렉토리 권한이 너무 넓다/)
    await chmod(dir, 0o700)
  })

  test('넓은 디렉토리는 채널 목록도 내주지 않는다 — 목록이 곧 채널 id 다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    await chmod(dir, 0o755)
    await expect(store.channels()).rejects.toThrow(/저장 디렉토리 권한이 너무 넓다/)
    await chmod(dir, 0o700)
  })

  // SCN-2
  test('첫 저장에서 디렉토리 0700 · 파일 0600 으로 생긴다', async () => {
    const nested = join(dir, 'messages')
    const store = new MessageStore({ dir: nested })
    await store.append(inbound())

    expect(await mode(nested)).toBe(0o700)
    expect(await mode(store.pathOf(A))).toBe(0o600)
  })

  test('임시 파일이 남지 않는다 — rename 으로 끝난다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    await store.append(inbound({ text: '둘' }))

    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter(n => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('보관 기한 (§6.3)', () => {
  // SCN-3
  test('옵션 없이 만들면 기한이 유한하다 — 무제한이 기본값이 아니다', () => {
    const store = new MessageStore({ dir })
    expect(Number.isFinite(store.retentionMs)).toBe(true)
    expect(store.retentionMs).toBeGreaterThan(0)
    expect(store.retentionMs).toBe(DEFAULT_RETENTION_MS)
  })

  test('무제한을 옵션으로도 받지 않는다', () => {
    expect(() => new MessageStore({ dir, retentionMs: Number.POSITIVE_INFINITY })).toThrow(
      /무제한 보관은 허용하지 않는다/,
    )
  })

  // SCN-4
  test('기한을 넘긴 항목이 파일 원문에서 사라진다 — 표시만이 아니다', async () => {
    let clock = 10_000
    const store = new MessageStore({ dir, retentionMs: 1_000, now: () => clock })

    await store.append(inbound({ text: '옛것', sentAt: 1 }))
    clock = 12_000 // 기한(1초)을 훌쩍 넘긴다
    await store.append(inbound({ text: '새것', sentAt: 2 }))

    // 원문을 **read 앞에서** 본다. read 는 경과분을 되쓰며 파일을 정리하므로,
    // 뒤에서 보면 append 가 하나도 안 지워도 이 테스트가 통과한다 — SCN-4 의
    // When 은 "읽거나 **쓴다**" 라 쓰기 절반이 여기서 고정돼야 한다.
    const raw = await rawMessages(store.pathOf(A))
    expect(raw.map(m => m.text)).toEqual(['새것'])
    expect(JSON.stringify(raw)).not.toContain('옛것')

    // 읽기 경로가 보여주는 것도 같다.
    expect((await store.read(A)).map(m => m.text)).toEqual(['새것'])
  })

  test('읽기만 해도 경과분이 파일에서 사라진다', async () => {
    let clock = 10_000
    const store = new MessageStore({ dir, retentionMs: 1_000, now: () => clock })
    await store.append(inbound({ text: '옛것' }))

    clock = 100_000
    expect(await store.read(A)).toEqual([])
    expect(await rawMessages(store.pathOf(A))).toEqual([])
  })

  test('개수 상한을 넘으면 오래된 것부터 버린다', async () => {
    const store = new MessageStore({ dir, maxPerChannel: 3 })
    for (let i = 1; i <= 5; i++) await store.append(inbound({ text: `m${i}`, sentAt: i }))

    expect((await store.read(A)).map(m => m.text)).toEqual(['m3', 'm4', 'm5'])
  })
})

describe('purge — 삭제는 실제 삭제다 (§6.3)', () => {
  // SCN-5
  test('A 를 purge 해도 B 는 그대로다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound({ channelId: A, text: 'A 의 말' }))
    await store.append(inbound({ channelId: B, text: 'B 의 말' }))

    expect(await store.purge(A)).toBe(true)

    expect(await store.read(A)).toEqual([])
    expect((await store.read(B)).map(m => m.text)).toEqual(['B 의 말'])
    expect(await store.channels()).toEqual([B])
  })

  // SCN-6
  test('purge 후 그 파일이 디스크에 없다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    const path = store.pathOf(A)

    await store.purge(A)

    await expect(stat(path)).rejects.toThrow(/ENOENT/)
  })

  test('없는 채널을 purge 하면 false — 없다는 사실이 오류는 아니다', async () => {
    const store = new MessageStore({ dir })
    expect(await store.purge(A)).toBe(false)
  })
})

describe('전달 상태 (§6.6)', () => {
  // SCN-7
  test('undelivered → markDelivered → undelivered 가 빈다', async () => {
    const store = new MessageStore({ dir })
    const saved = await store.append(inbound({ text: '아직 안 봤다' }))

    const before = await store.undelivered(A)
    expect(before.map(m => m.id)).toEqual([saved.id])

    expect(await store.markDelivered([saved.id])).toBe(1)
    expect(await store.undelivered(A)).toEqual([])

    // 두 번 표시해도 개수가 늘지 않는다 — 멱등이다.
    expect(await store.markDelivered([saved.id])).toBe(0)
  })

  test('발신은 애초에 미전달이 아니다 — 주입 대상이 아니라서다', async () => {
    const store = new MessageStore({ dir })
    const out = await store.append({
      channelId: A,
      direction: 'out',
      axis: 'external',
      text: '내가 한 말',
      sentAt: 5,
    })

    expect(out.delivered).toBe(true)
    expect(await store.undelivered(A)).toEqual([])
  })

  test('채널을 안 주면 전 채널의 미전달을 시간순으로 모은다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound({ channelId: B, text: '나중', sentAt: 200 }))
    await store.append(inbound({ channelId: A, text: '먼저', sentAt: 100 }))

    expect((await store.undelivered()).map(m => m.text)).toEqual(['먼저', '나중'])
  })

  test('전달 상태가 파일에 남는다 — 프로세스가 죽어도 다시 주입하지 않는다', async () => {
    const store = new MessageStore({ dir })
    const saved = await store.append(inbound())
    await store.markDelivered([saved.id])

    const reopened = new MessageStore({ dir })
    expect(await reopened.undelivered(A)).toEqual([])
  })
})

describe('축과 방향 (§6.4)', () => {
  // SCN-8
  test('external / internal 채널의 기록에 축이 각각 박힌다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound({ channelId: A, axis: 'external', text: '남의 말' }))
    await store.append(inbound({ channelId: B, axis: 'internal', text: '내 다른 세션' }))

    expect((await store.read(A))[0]?.axis).toBe('external')
    expect((await store.read(B))[0]?.axis).toBe('internal')

    // 파일에도 박혀 있어야 한다 — UI 가 계산해 내는 값이 아니다.
    expect((await rawMessages(store.pathOf(A)))[0]?.axis).toBe('external')
    expect((await rawMessages(store.pathOf(B)))[0]?.axis).toBe('internal')
  })

  test('모르는 축은 저장되지 않는다', async () => {
    const store = new MessageStore({ dir })
    await expect(store.append(inbound({ axis: 'internel' as never }))).rejects.toThrow(/axis 는/)
  })

  // SCN-9
  test('in / out 방향이 구분돼 남는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound({ text: '받은 말', sentAt: 1 }))
    await store.append({
      channelId: A,
      direction: 'out',
      axis: 'external',
      text: '보낸 말',
      sentAt: 2,
    })

    const raw = await rawMessages(store.pathOf(A))
    expect(raw.map(m => [m.direction, m.text])).toEqual([
      ['in', '받은 말'],
      ['out', '보낸 말'],
    ])
  })
})

describe('형태와 순서', () => {
  test('시간순 오름차순이고 limit 은 최신 쪽을 남긴다', async () => {
    const store = new MessageStore({ dir })
    for (const t of [30, 10, 20]) await store.append(inbound({ text: `t${t}`, sentAt: t }))

    expect((await store.read(A)).map(m => m.text)).toEqual(['t10', 't20', 't30'])
    expect((await store.read(A, 2)).map(m => m.text)).toEqual(['t20', 't30'])
  })

  test('경로 조작이 되는 채널 id 를 받지 않는다', async () => {
    const store = new MessageStore({ dir })
    await expect(store.read('../../etc/passwd')).rejects.toThrow(/채널 id 가 올바르지 않다/)
    await expect(store.append(inbound({ channelId: 'ZZZZ' }))).rejects.toThrow(/채널 id 가 올바르지 않다/)
  })

  test('바이트 값은 hex 로만 받는다', async () => {
    const store = new MessageStore({ dir })
    await expect(store.append(inbound({ senderKeyId: 'not-hex' }))).rejects.toThrow(/senderKeyId/)
  })

  test('id 를 안 주면 새로 뽑고, 주면 그대로 쓴다', async () => {
    const store = new MessageStore({ dir })
    const auto = await store.append(inbound({ id: undefined, sentAt: 1 }))
    const given = await store.append(inbound({ id: 'abcd1234', sentAt: 2 }))

    expect(auto.id).toMatch(/^[0-9a-f]{32}$/)
    expect(given.id).toBe('abcd1234')
  })

  test('손상된 파일은 조용히 빈 배열이 되지 않는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())
    await writeFile(store.pathOf(A), '{ 반쪽', { mode: 0o600 })

    await expect(store.read(A)).rejects.toThrow(/손상됐다/)
  })

  test('파일이 주장하는 채널이 파일명과 다르면 읽지 않는다 — 대화가 오귀속된다 (§6.4)', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    body.messages[0].channelId = B
    await writeFile(store.pathOf(A), JSON.stringify(body), { mode: 0o600 })

    await expect(store.read(A)).rejects.toThrow(/다른 채널을 주장한다/)
  })

  test('디스크의 hex 필드도 다시 검사한다 — 쓸 때 봤다고 읽을 때 믿지 않는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    body.messages[0].senderKeyId = 'not-hex'
    await writeFile(store.pathOf(A), JSON.stringify(body), { mode: 0o600 })

    await expect(store.read(A)).rejects.toThrow(/senderKeyId/)
  })

  test('디스크의 id 도 쓰기 경로와 같은 검사를 받는다 — 형제 필드만 검사하면 비대칭이 남는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    // id 는 `markDelivered` 의 매칭 키이자 `inbox`·훅·조망 UI 로 나가는 표시 값이다.
    body.messages[0].id = '../../etc/passwd NOT HEX <script>'
    await writeFile(store.pathOf(A), JSON.stringify(body), { mode: 0o600 })

    await expect(store.read(A)).rejects.toThrow(/messages\[0\]\.id/)
  })

  test('모르는 필드는 디스크에서 딸려 오지 않는다', async () => {
    const store = new MessageStore({ dir })
    await store.append(inbound())

    const body = JSON.parse(await readFile(store.pathOf(A), 'utf8'))
    body.messages[0].injected = '남이 심은 것'
    await writeFile(store.pathOf(A), JSON.stringify(body), { mode: 0o600 })

    expect((await store.read(A))[0]).not.toHaveProperty('injected')
  })

  test('없는 채널은 빈 배열이다 — 없다는 사실이 오류는 아니다', async () => {
    const store = new MessageStore({ dir })
    expect(await store.read(A)).toEqual([])
    expect(await store.channels()).toEqual([])
  })

  test('hops·replyTo 는 준 것만 남는다', async () => {
    const store = new MessageStore({ dir })
    const saved = await store.append(inbound({ hops: 2, replyTo: 'ff00' }))

    expect(saved.hops).toBe(2)
    expect(saved.replyTo).toBe('ff00')
    expect((await rawMessages(store.pathOf(A)))[0]?.hops).toBe(2)
  })
})
