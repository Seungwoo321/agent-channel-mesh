# agent-channel-mesh

종단 간 암호화된 코딩 에이전트 메시징 메시. Claude Code 와 Codex 를 지원한다. 설계는 [docs/architecture.md](docs/architecture.md) 가 정본이다.

## 규약

- **런타임은 Bun.** `bun <file>`, `bun test`, `bun install`, `bunx`. Bun 이 `.env` 를 자동 로드하므로 dotenv 를 쓰지 않는다.
- **Bun 내장 API 우선** — `Bun.serve()`(express 대신), `bun:sqlite`, `Bun.file`, 내장 `WebSocket`. 단 **암호는 예외**다(아래).
- 로컬 생성물은 `.local/`, 순수 임시 파일은 `tmp/`. 둘 다 gitignore 돼 있다.
- **`vercel env pull` 을 레포 루트에 하지 않는다.** Bun 이 루트 `.env.local` 을 자동 로드하므로, 로컬 실행과 `bun test` 가 프리뷰 Upstash 를 조용히 물게 된다. 뽑아야 하면 `.local/` 아래로 받아 `--env-file` 로 명시해 쓴다. 비밀이 든 파일 권한은 600 이다.

## 암호 — 넘지 말아야 할 선

`docs/architecture.md` §10 이 근거를 갖고 확정한 사항이다. 바꾸려면 그 문서를 먼저 고친다.

- **Bun 의 `crypto.subtle` 로 X25519 를 하지 않는다.** `deriveBits({name:"X25519"})` 가 `NotSupportedError` 로 죽는다 — KEM 에 필요한 바로 그 연산이다. 반드시 `@hpke/dhkem-x25519` 를 거친다(내부에 `@noble` 을 품고 있어 subtle 을 안 탄다).
- **암호 프리미티브를 직접 조합하지 않는다.** 키 래핑은 HPKE(RFC 9180), 본문은 XChaCha20-Poly1305. X25519+HKDF+AEAD 를 손으로 엮지 않는다.
- **Double Ratchet 을 직접 구현하지 않는다.** 채택하지 않기로 한 사항이며(§10.4), 뒤집는다면 `@signalapp/libsignal-client` 를 쓴다. 잘못 만든 래칫은 테스트를 통과하면서 약속한 보안을 전혀 주지 않는다.
- **본문 nonce 는 랜덤 192비트**(XChaCha20). 카운터를 쓰지 않는다 — 브릿지는 재시작되는 서브프로세스라 카운터를 잃으면 nonce 를 재사용한다.
- **지문을 잘라서 보여주지 않는다.** 16비트 접두는 8초면 갈아 맞춘다. short id 를 만들지 않는다.
- **key id 를 한쪽 공개키에서만 뽑지 않는다.** 두 공개키를 함께 해시한다 — KEM 키 단독이면 §10.12 의 소유권 검사가 무력해진다(서명키는 HKDF 로 분리돼 있어 KEM 키에서 계산되지 않고, KEM 키는 채널 멤버 전원이 안다). 파생은 `src/identity/verify.ts` 가 단독으로 소유한다.
- **보안 주장을 과장하지 않는다.** 메타데이터는 노출되고, 수신자 키 유출에 대한 순방향 비밀성은 없다. README 가 이미 밝히고 있으므로 약화시키지 않는다.

## 코어와 어댑터 경계

**메시 코어에 에이전트 고유 코드를 넣지 않는다.** 신원·암복호·릴레이 통신·발화 제어는 전부 에이전트 무관이어야 한다. Claude Code 든 Codex 든 같은 코어를 지나야 보안 속성이 일관된다.

에이전트별로 다른 것은 어댑터 하나뿐이고, 인터페이스는 양방향 두 개다 — 세션→메시(`send` 툴), 메시→세션(전달). 두 번째가 에이전트마다 갈린다.

- `claude/channel` 호출은 **Claude 어댑터 안에만** 존재한다. 코어에서 참조하지 않는다.
- 코어는 "메시지가 도착했다"를 어댑터에 알릴 뿐, 그것이 주입되는지 수신함에 쌓이는지 모른다.
- 어댑터는 `MeshNode` 만 쓴다. `seal`/`receive` 를 직접 부르면 검사 순서나 발화 제어를 빠뜨릴 수 있고, 그러면 에이전트마다 보안 속성이 갈린다.
- **전달 방식은 `--delivery` 로 명시한다.** 환경을 보고 추측하지 않는다 — 틀리면 "동작하는 것처럼 보이는 고장"이 된다. `push`·`inbox`·`both` 중 하나이며, 명시는 필수다.

## import specifier — `.ts` 를 쓰지 않는다

**릴레이로 배포되는 코드에서 `.ts` 확장자 import 를 쓰지 않는다.** Bun 관례상 자연스럽지만 Vercel 에서 죽는다.

- Vercel 은 배포 전에 모든 `.ts` 를 `.js` 로 트랜스파일한다. 런타임 디스크에 `.ts` 파일이 **존재하지 않으므로** `.ts` 로 끝나는 specifier 는 없는 파일을 가리킨다.
- **빌드는 성공하고 매 요청마다 죽는다** — `ResolveMessage: Cannot find module './x.ts'`. 정확히 "동작하는 것처럼 보이는 고장"이다.
- `bunVersion` 과 무관하다. Bun 문제가 아니라 빌드 산출물 문제다.
- **그래프 안 어디든 하나라도 있으면 죽는다.** 깊이·위치 무관이라 진입점 파일만 고치는 것으로는 부족하다 — 진입점(루트 `index.ts` → `src/server.ts`)에서 도달 가능한 전체가 대상이다.

`.js` specifier 를 쓴다(`'./store.js'`). 소스는 `.ts` 이고 specifier 는 산출물 기준이라는 TypeScript ESM 표준 관례이며, 무확장과 달리 Node ESM 에서도 유효하다. 현 tsconfig(`moduleResolution: "bundler"`)에서 `tsc --noEmit` 와 `bun run` 둘 다 통과한다.

## 릴레이 드레인과 로컬 저장소

`docs/architecture.md` §6.3·§6.6 이 확정한 사항이다.

- **릴레이를 드레인하는 곳은 코어 한 곳뿐이다.** 큐는 꺼내면 사라지므로 주입 경로와 폴링 경로가 각자 릴레이를 치면 서로의 메시지를 훔친다. 어댑터·훅에서 릴레이를 직접 부르지 않는다.
- **정본은 로컬 저장소이고 주입은 알림이다.** 드레인 결과를 저장소에 먼저 쓴 뒤 주입한다. `inbox` 툴은 릴레이가 아니라 저장소를 읽는다.
- **중복 전달은 지시문이 아니라 `delivered` 상태로 막는다.** 훅은 미전달분만 본다. 프롬프트 룰로 정책을 주입하지 않는다 — 압축되면 사라진다.
- 저장소 파일 권한은 **600**. 보관 기한 기본값을 무제한으로 두지 않는다.

## 설정 파일

어댑터의 유일한 입력이다(`~/.agent-channel-mesh/config.json`). 시드와 채널 비밀이 들어 있으므로 **권한이 600 보다 넓으면 읽지 않고 죽는다.** 이 검사를 경고 문구로 완화하지 않는다 — 이 파일 하나로 모든 암호가 무력화된다.

## 채널 프로토콜 (Claude 어댑터 한정)

- 채널은 **stdio MCP 서버**다. Claude Code 가 서브프로세스로 띄운다 — 순수 서버리스로는 세션에 닿을 수 없다.
- `meta` 키는 `[A-Za-z0-9_]` 만 유효하다. **하이픈은 조용히 삭제된다.**
- 프로토콜 동작은 `spike/channel.ts` 로 4/4 검증돼 있다(채널 등록·인바운드 주입·아웃바운드 `reply`·발신자 게이팅).
- 로컬 실행: `claude --dangerously-load-development-channels server:mesh-spike`

## Codex 훅 — 조용히 사라지는 자리

`docs/architecture.md` §6.6 이 실측으로 확정한 사항이다. 셋 다 "파일에는 있는데 한 번도 돌지 않는" 고장이라 눈으로는 안 보인다.

- **`async` 를 달지 않는다.** Codex 는 async 훅을 지원하지 않고, 만나면 등록 목록에서 통째로 뺀 뒤 경고 한 줄만 남긴다. 턴 중간 알림은 `PostToolUse` 가 맡는다 — 툴 호출마다 도는 동기 훅이다.
- **조정값은 camelCase 다** (`timeout` · `additionalContextLimit`). `timeout_sec` · `additional_context_limit` 은 바이너리에 이름이 있어도 설정 파일 파서가 읽지 않는다 — 조용히 버리고 기본값(600초 · 무제한)으로 떨어진다.
- **`codex doctor` 로 검증하지 않는다.** 일부러 깨뜨린 JSON 도 `config.load: ok` 다. 확인하는 유일한 길은 `codex app-server` 에 JSON-RPC `hooks/list` 를 던져 `warnings`·`errors` 를 보는 것이다.
- 실측은 **임시 `CODEX_HOME`** 에서 한다. 사용자의 `~/.codex` 에 설치기를 돌리지 않는다.

## 플러그인 배포 — 레포 하나가 두 마켓플레이스다

`docs/architecture.md` §11.1 참조.

- **매니페스트·훅 파일을 손으로 고치지 않는다.** `src/install/plugin.ts` 가 생성기이고, 커밋된 산출물이 생성 결과와 같은지는 `test/plugin.test.ts` 가 지킨다. 손으로 고치면 다음 생성에서 조용히 되돌아간다.
- 훅 이벤트 정의는 `src/install/hooks.ts` 의 `HOOK_EVENTS` **한 곳**에만 있다. 플러그인 쪽에 따로 적으면 설치 경로마다 알림이 갈린다.
- **`bunx <패키지>@<버전>` 의 버전을 뗀 채로 두지 않는다.** 플러그인은 클론만 되고 의존성 설치가 없어 소스 경로로는 못 돌고, `@latest` 면 레지스트리가 바뀌는 것만으로 팀원들의 훅 동작이 갈린다.

## 테스트

```ts
import { test, expect } from "bun:test"
```

암호 코드는 테스트 벡터로 검증한다 — round-trip 이 되는 것만으로는 보안을 증명하지 못한다.

## 커밋

에이전트는 명시적 지시 없이 커밋·푸시하지 않는다.
