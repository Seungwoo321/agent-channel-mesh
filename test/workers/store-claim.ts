/**
 * 서브프로세스 워커 — 선점만 하고 놓지 않는다.
 *
 * 선점한 id 를 한 줄에 하나씩 stdout 으로 낸다. 두 워커의 출력을 합쳐 **중복이
 * 0** 이면, 리스가 프로세스 사이에서 실제로 배타적이라는 뜻이다. 표시(markDelivered)
 * 를 하지 않는 이유는, 선점 자체가 배타적인지를 보려는 것이기 때문이다.
 *
 * **출발선을 맞춘다.** Bun 프로세스 기동에 수백 ms 가 들어서, 그냥 띄우면 먼저
 * 뜬 쪽이 큐를 다 비운 뒤에 두 번째가 시작한다 — 경합이 아예 일어나지 않은
 * 실행을 "겹쳐도 안 겹친다"의 증거로 쓰게 된다. 그래서 준비되면 ready 파일을
 * 남기고 go 파일을 기다린다.
 *
 * 사용: bun run test/workers/store-claim.ts <dir> <ch> <durationMs> <batch> <ready> <go>
 */
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { MessageStore } from '../../src/store/store.js'

const [dir, channelId, durationRaw, batchRaw, ready, go] = process.argv.slice(2)
if (dir === undefined || channelId === undefined || durationRaw === undefined) {
  throw new Error('사용: store-claim.ts <dir> <ch> <durationMs> [batch] [ready] [go]')
}

const store = new MessageStore({ dir })
const batch = batchRaw === undefined ? 3 : Number(batchRaw)

if (ready !== undefined && go !== undefined) {
  await writeFile(ready, String(process.pid))
  while (!existsSync(go)) await new Promise(resolve => setTimeout(resolve, 1))
}

const deadline = Date.now() + Number(durationRaw)
const lines: string[] = []
let emptyRounds = 0

while (Date.now() < deadline && emptyRounds < 5) {
  const claimed = await store.claimUndelivered(channelId, batch)
  if (claimed.length === 0) {
    emptyRounds += 1
    await new Promise(resolve => setTimeout(resolve, 2))
    continue
  }
  emptyRounds = 0
  for (const m of claimed) lines.push(m.id)
  // 한 라운드마다 놓고 잠깐 쉰다. 쉬지 않고 다시 잡으면 먼저 뜬 쪽이 큐를
  // 통째로 비우고, 그러면 "동시에 집었다"가 아니라 순차 실행을 검사하게 된다.
  await new Promise(resolve => setTimeout(resolve, 1))
}

process.stdout.write(lines.join('\n'))
