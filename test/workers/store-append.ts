/**
 * 서브프로세스 워커 — 한 채널에 계속 append 한다.
 *
 * **테스트 파일이 아니다.** `bun test` 의 파일 패턴(`*.test.ts` 등)에 걸리지
 * 않도록 이름을 달리 뒀고, 실행은 테스트가 `Bun.spawn` 으로 한다.
 *
 * 같은 프로세스 안의 `Promise.all` 로는 프로세스 간 경합이 재현되지 않는다 —
 * 한 이벤트 루프 안에서는 `await` 사이에 다른 **프로세스**가 끼어들 수 없기
 * 때문이 아니라, 끼어들더라도 같은 힙의 상태를 공유해 결과가 달라지기
 * 때문이다. 잠금이 지키는 것은 디스크 위의 read-modify-write 이므로, 증명도
 * 진짜 별개 프로세스로 해야 한다.
 *
 * 사용: bun run test/workers/store-append.ts <dir> <channelId> <count> <tag>
 */
import { MessageStore } from '../../src/store/store.js'

const [dir, channelId, countRaw, tag] = process.argv.slice(2)
if (dir === undefined || channelId === undefined || countRaw === undefined || tag === undefined) {
  throw new Error('사용: store-append.ts <dir> <channelId> <count> <tag>')
}

const store = new MessageStore({ dir })
const count = Number(countRaw)

for (let i = 0; i < count; i++) {
  await store.append({
    channelId,
    direction: 'in',
    axis: 'external',
    senderKeyId: 'deadbeef',
    text: `${tag}-${String(i)}`,
    sentAt: 1_000 + i,
  })
}
