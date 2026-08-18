/**
 * 서브프로세스 워커 — 선점하고 전달 표시하는 쪽을 흉내 낸다 (훅 역할).
 *
 * append 하는 쪽(어댑터)과 **동시에** 같은 파일을 읽고 고쳐 쓴다. 잠금이 없으면
 * 이 워커의 되쓰기가 그 사이 append 된 것을 통째로 덮어 메시지가 사라진다.
 *
 * 사용: bun run test/workers/store-churn.ts <dir> <channelId> <durationMs>
 */
import { MessageStore } from '../../src/store/store.js'

const [dir, channelId, durationRaw] = process.argv.slice(2)
if (dir === undefined || channelId === undefined || durationRaw === undefined) {
  throw new Error('사용: store-churn.ts <dir> <channelId> <durationMs>')
}

const store = new MessageStore({ dir })
const deadline = Date.now() + Number(durationRaw)

while (Date.now() < deadline) {
  const claimed = await store.claimUndelivered(channelId, 3)
  if (claimed.length > 0) await store.markDelivered(claimed.map(m => m.id))
  await new Promise(resolve => setTimeout(resolve, 1))
}
