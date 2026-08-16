/**
 * 아카이브 방지 핑 — Vercel Cron 이 부른다
 *
 * Upstash 무료 티어는 **30일 동안 명령이 하나도 없으면 DB 를 아카이브**한다.
 * 아카이브되면 인스턴스가 제거되고 REST 엔드포인트가 죽는다 — 다시 만들 수는
 * 있지만 URL 과 토큰이 새 값이라 환경변수를 갈아끼우고 재배포해야 한다.
 * 그리고 그 사실은 조용히 일어나서, 릴레이가 실패하기 시작한 뒤에야 안다.
 *
 * 주 1회 명령을 하나 보내면 그 타이머가 리셋되므로 아카이브가 일어나지 않는다.
 * 실제 저장소를 건드려야 의미가 있다 — `/health` 는 Redis 에 닿지 않아서
 * 아무 명령도 발생시키지 않는다.
 *
 * 존재하지 않는 키의 `depth` 를 읽는다. 읽기 한 번이라 데이터를 바꾸지 않고,
 * Vercel 이 cron 을 중복 호출해도(문서가 명시하는 best-effort 전달) 결과가
 * 같다 — 멱등이어야 한다는 요구를 읽기 연산으로 만족시킨다.
 *
 * 저장소를 인자로 받는다. 진입점(`src/server.ts`)이 모듈 로드 때 한 번 고른
 * 그 저장소를 그대로 써야 핑이 실제로 릴레이가 쓰는 DB 에 닿는다 — 여기서
 * 따로 만들면 두 경로가 다른 DB 를 볼 수 있고, 그러면 아카이브를 막지 못하면서
 * 막고 있다고 착각하게 된다.
 */
import type { Store } from './store.js'

/** 이 키는 절대 쓰이지 않는다 — key id 는 hex 16자라 이 형태와 겹치지 않는다. */
const KEEPALIVE_KEY = '__keepalive__'

export async function keepalive(request: Request, store: Store): Promise<Response> {
  // Cron 이 보내는 것은 GET 뿐이다. `createHandler` 의 모든 경로가 메서드를
  // 확인하므로 여기만 아무 메서드나 받으면 릴레이의 규칙이 경로마다 갈린다.
  if (request.method !== 'GET') {
    return json({ ok: false, detail: `받지 않는 메서드다: ${request.method}` }, 405, {
      allow: 'GET',
    })
  }

  // Vercel 은 cron 요청에 인증을 자동으로 붙이지 않는다. CRON_SECRET 을
  // 설정하면 `Authorization: Bearer <값>` 을 실어 보낼 뿐, **검증은 여기서
  // 해야 한다.** 안 하면 이 경로는 누구나 부를 수 있는 공개 엔드포인트다.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return json({ ok: false, detail: 'CRON_SECRET 이 설정되지 않았다' }, 500)
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json({ ok: false, detail: 'unauthorized' }, 401)
  }

  try {
    const depth = await store.depth(KEEPALIVE_KEY)
    return json({ ok: true, depth })
  } catch (e) {
    // 실패를 200 으로 감추지 않는다. Vercel 이 cron 실패를 알려야
    // 아카이브가 임박한 것을 눈치챌 수 있다 — cron 은 재시도하지 않는다.
    return json({ ok: false, detail: e instanceof Error ? e.message : String(e) }, 500)
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    // 405 는 `Allow` 를 반드시 실어야 한다 (RFC 9110 §15.5.6).
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}
