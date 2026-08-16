/**
 * 릴레이 진입점 테스트
 *
 * 인자 해석과, 실제로 뜬 서버가 봉투를 왕복시키는지 본다. HTTP 계층
 * 자체는 `http.test.ts` 가 덮으므로 여기서는 "진입점이 그 핸들러를
 * 제대로 띄우는가"만 확인한다.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs, start, DEFAULT_PORT } from '../src/relay/serve.js'
import { DEFAULT_TTL_MS, DEFAULT_MAX_QUEUE } from '../src/relay/store.js'

describe('인자', () => {
  test('기본값은 루프백이다 — 큐가 인증되지 않으므로 공개는 명시여야 한다', () => {
    expect(parseArgs([])).toEqual({
      port: DEFAULT_PORT,
      host: '127.0.0.1',
      ttlMs: DEFAULT_TTL_MS,
      maxQueue: DEFAULT_MAX_QUEUE,
      origin: { host: 'default', port: 'default' },
    })
  })

  test('플래그가 기본값을 덮는다', () => {
    const args = parseArgs(['--port', '9000', '--host', '0.0.0.0', '--ttl', '1000', '--max-queue', '5'])
    expect(args).toEqual({
      port: 9000,
      host: '0.0.0.0',
      ttlMs: 1000,
      maxQueue: 5,
      origin: { host: 'flag', port: 'flag' },
    })
  })

  test('출처를 기록한다 — 기동 실패 때 어디를 고칠지가 여기서 나온다', () => {
    // 같은 `'0.0.0.0'` 이라도 사람이 타이핑한 것과 셸이 흘려보낸 것은
    // 고칠 곳이 다르다. 값만 남기면 그 구분이 사라진다.
    expect(parseArgs([], { HOST: '0.0.0.0', PORT: '9100' }).origin).toEqual({ host: 'env', port: 'env' })
    expect(parseArgs(['--host', '0.0.0.0'], { PORT: '9100' }).origin).toEqual({ host: 'flag', port: 'env' })
    // 값이 거부돼 기본값으로 되돌아갔으면 출처도 기본값이다 — 사용자가
    // 준 적 없는 값을 지목하면 안 된다.
    expect(parseArgs([], { HOST: '' }).origin).toEqual({ host: 'default', port: 'default' })
  })

  test('환경변수를 읽는다', () => {
    expect(parseArgs([], { PORT: '9100', HOST: '0.0.0.0' })).toMatchObject({
      port: 9100,
      host: '0.0.0.0',
    })
  })

  test('플래그가 환경변수를 이긴다', () => {
    expect(parseArgs(['--port', '9200'], { PORT: '9100' }).port).toBe(9200)
  })

  test('모르는 인자는 던진다 — 오타가 조용히 기본값이 되면 안 된다', () => {
    expect(() => parseArgs(['--prot', '9000'])).toThrow(/모르는 인자/)
  })

  test('값이 없는 플래그는 던진다', () => {
    expect(() => parseArgs(['--port'])).toThrow(/--port/)
  })

  test('숫자가 아닌 포트는 던진다', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/--port/)
  })

  test('0 이하 TTL·큐 상한은 거부한다', () => {
    expect(() => parseArgs(['--ttl', '0'])).toThrow(/--ttl/)
    expect(() => parseArgs(['--max-queue', '-1'])).toThrow(/--max-queue/)
  })

  test('포트 0 은 유효하다 — OS 가 빈 포트를 고른다', () => {
    // `start()` 가 이미 지원하는 계약이다. CLI 만 이걸 막고 있었다.
    expect(parseArgs(['--port', '0']).port).toBe(0)
    expect(parseArgs([], { PORT: '0' }).port).toBe(0)
  })

  test('포트 범위와 정수를 지킨다 — Bun 안쪽에서 터지게 두지 않는다', () => {
    expect(parseArgs(['--port', '65535']).port).toBe(65535)
    expect(() => parseArgs(['--port', '65536'])).toThrow(/--port/)
    expect(() => parseArgs(['--port', '1.5'])).toThrow(/--port/)
    expect(() => parseArgs(['--port', '-1'])).toThrow(/--port/)
  })

  test('빈 포트 문자열이 0 으로 둔갑하지 않는다', () => {
    // `Number('')` 와 `Number(' ')` 가 0 이라, 그냥 넘기면 빈 값이 ephemeral
    // 포트가 된다 — 값을 안 준 것과 0 을 준 것은 다른 의도다.
    expect(() => parseArgs(['--port', ''])).toThrow(/--port/)
    expect(() => parseArgs(['--port', ' '])).toThrow(/--port/)
  })

  test('--host 도 값이 있어야 한다', () => {
    // 값이 없으면 조용히 기본값이 됐다. 나머지 세 플래그는 던지는데
    // 호스트만 안 던지면, 바인딩 주소가 가장 조용히 틀리는 인자가 된다.
    expect(() => parseArgs(['--host'])).toThrow(/--host/)
    expect(parseArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0')
  })

  test('--host 가 다음 플래그를 삼키지 않는다', () => {
    // `--host --port 9000` 은 `"--port"` 에 바인딩을 시도하는 게 아니라
    // 오타로 잡혀야 한다. 큐가 인증되지 않으므로(§10.12) 의도하지 않은
    // 주소에 조용히 묶이는 것이 이 파서에서 가장 비싼 실패다.
    expect(() => parseArgs(['--host', '--port', '9000'])).toThrow(/--host/)
  })

  test('공백뿐인 호스트는 값을 안 준 것이다', () => {
    // `' '` 는 파서를 통과해도 아무 데도 바인딩되지 않는다. 빈 문자열과
    // 같은 것이 변장한 것뿐이라 같은 자리에서 막는다 — 호스트명의 생김새를
    // 주장하는 검사가 아니다.
    expect(() => parseArgs(['--host', ' '])).toThrow(/--host/)
    expect(() => parseArgs(['--host', '\t  '])).toThrow(/--host/)
    expect(parseArgs([], { HOST: '   ' }).host).toBe('127.0.0.1')
  })

  test('빈 HOST 는 기본값으로 되돌린다', () => {
    // 환경변수는 셸 프로파일에서 빈 값으로 흘러들어올 수 있다 — 그것 때문에
    // 서버를 죽이지 않는다. 플래그와 반대 방향인 것이 의도다.
    expect(parseArgs([], { HOST: '' }).host).toBe('127.0.0.1')
    expect(parseArgs([], { HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  test('잘못된 값의 처리는 출처에 따라 다르다', () => {
    // 플래그는 사람이 이번 호출에 타이핑한 것이라 조용히 바꾸면 오타가
    // 다른 포트가 된다 — 던진다. 환경변수는 플랫폼·셸에서 흘러들어올 수
    // 있는 주변 값이라 서버를 죽이지 않는다 — 기본값으로 되돌린다.
    expect(() => parseArgs(['--port', '99999'])).toThrow(/--port/)
    expect(parseArgs([], { PORT: '99999' }).port).toBe(DEFAULT_PORT)
    expect(parseArgs([], { ACM_TTL_MS: 'abc' }).ttlMs).toBe(DEFAULT_TTL_MS)
  })
})

describe('실행', () => {
  test('뜬 서버가 health 에 응답한다', async () => {
    const server = start({ port: 0, host: '127.0.0.1', ttlMs: DEFAULT_TTL_MS, maxQueue: 10 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      server.stop()
    }
  })

  test('port 0 이면 OS 가 고른 실제 포트를 돌려준다', () => {
    const server = start({ port: 0, host: '127.0.0.1', ttlMs: DEFAULT_TTL_MS, maxQueue: 10 })
    try {
      expect(server.port).toBeGreaterThan(0)
      expect(server.url).toContain(String(server.port))
    } finally {
      server.stop()
    }
  })

  test('바인딩 실패는 우리가 넘긴 값과 출처를 달고 나온다', () => {
    // Bun 은 원인과 무관하게 포트를 지목한다 — 호스트가 문제여도, `--port 0`
    // 처럼 이 프로젝트가 유효하다고 문서화한 값을 범인으로 부른다. 형식
    // 검사로는 이 호스트를 미리 걸러낼 수 없으므로(그런 검사는 유효한 값도
    // 막는다), 누가 틀렸는지 추측하지 않고 넘긴 값을 그대로 보여준다.
    let thrown: unknown
    try {
      start({
        port: 0,
        host: 'not!a!hostname',
        ttlMs: DEFAULT_TTL_MS,
        maxQueue: 10,
        origin: { host: 'flag', port: 'flag' },
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error
    expect(error.message).toContain("--host 'not!a!hostname'")
    expect(error.message).toContain('--port 0')
    expect(error.message).toContain('플래그')
    // 원문은 지우지 않는다. 문구 자체는 Bun 것이라 바뀔 수 있으므로 문구가
    // 아니라 "원문이 남아 있다"만 본다.
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.message).toContain((error.cause as Error).message)
  })

  test('출처가 없으면 기본값으로 설명한다', () => {
    // 직접 조립한 `ServeArgs` 에는 출처가 없다. 없는 정보를 지어내지 않는다.
    expect(() => start({ port: 0, host: ' ', ttlMs: DEFAULT_TTL_MS, maxQueue: 10 })).toThrow(/기본값/)
  })

  test('모르는 경로는 404 다', async () => {
    const server = start({ port: 0, host: '127.0.0.1', ttlMs: DEFAULT_TTL_MS, maxQueue: 10 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/nope`)
      expect(res.status).toBe(404)
    } finally {
      server.stop()
    }
  })

  test('stop 뒤에는 연결이 되지 않는다', async () => {
    const server = start({ port: 0, host: '127.0.0.1', ttlMs: DEFAULT_TTL_MS, maxQueue: 10 })
    const port = server.port
    server.stop()
    // 포트가 풀릴 때까지 아주 짧게 기다린다.
    await Bun.sleep(50)
    expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })
})
