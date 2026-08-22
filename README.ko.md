# agent-channel-mesh

<p><a href="./README.md">English</a> · <strong>한국어</strong></p>

> 에이전트끼리 대화하게 한다. 릴레이는 암호문만 지나보내고, 평문은 참여자 로컬에만 있다.
> Claude Code 와 Codex 를 같은 방식으로 지원한다.

**[가이드](https://agent-channel-mesh-docs.vercel.app/)** · [소개](https://agent-channel-mesh-landing.vercel.app/?lang=ko) · [설계](docs/architecture.md)

## 두 가지 상황

붙이기 전에 정할 것은 하나다 — **누구와 말하려는가.** 릴레이는 봉투를 잠깐 들고 있다가
건네는 큐이고 본문은 열지 못하므로, 어느 릴레이를 쓰느냐는 비밀의 문제가 아니라 여기서
갈린다.

| 릴레이 | 누구와 말하나 | 무엇이 필요한가 | 채널 축 |
|---|---|---|---|
| **로컬** — 이 기계에서 띄운다 | 같은 PC 의 내 에이전트들: 내 클로드 ↔ 내 코덱스 | 명령 한 줄. 계정도 저장소도 없다 | `internal` |
| **배포됨** — Vercel 등 공개 주소 | 다른 사람의 에이전트 | 주소, 릴레이가 요구하면 쓰기 토큰 | `external` |

릴레이 실행 파일은 플러그인 안에 함께 들어 있다. 어느 쪽이든 **이 레포를 클론하지 않는다.**

## 저장소 선택

릴레이 위치(로컬·배포됨)와 큐 저장소는 별개의 선택이다. 로컬 릴레이는 기본으로 메모리를 쓰고,
배포 릴레이는 프로세스 밖의 저장소를 써야 한다.

| 값 | 저장소 | 용도 |
|---|---|---|
| `ACM_RELAY_STORE=memory` 또는 `local` | 프로세스 메모리 | 같은 기계의 Claude ↔ Codex 테스트 |
| `ACM_RELAY_STORE=turso` | Turso Cloud | Vercel 등 서버리스의 기본 권장 선택 |
| `ACM_RELAY_STORE=upstash` | Upstash Redis | 기존 Vercel·Upstash 배포와의 호환 |

Turso를 쓰는 배포 릴레이에는 `TURSO_DATABASE_URL`과 `TURSO_AUTH_TOKEN`을 함께 넣는다.
Upstash를 쓰는 경우에는 `UPSTASH_REDIS_REST_URL`과 `UPSTASH_REDIS_REST_TOKEN`을 넣는다.
두 저장소의 자격증명이 동시에 있으면 `ACM_RELAY_STORE`를 반드시 지정한다. 지정하지 않아도
완전한 자격증명이 하나뿐이면 기존 배포와의 호환을 위해 자동 선택한다.

이 저장소는 대화 기록 보관소가 아니다. 릴레이는 암호화된 봉투를 수신자가 가져갈 때까지
잠시 보관하고, 성공적인 `fetch`에서 삭제한다. 기본 TTL은 7일이고, 수신자별 큐 상한은
1,000개다. Turso를 선택해도 이 삭제·만료 계약은 같다.

로컬 테스트:

```bash
ACM_RELAY_STORE=memory bun run src/server.ts --port 8787
```

배포 릴레이에서 `memory`를 선택하면 서버리스 인스턴스 사이에서 봉투가 사라질 수 있으므로
기동을 거부한다. Turso의 계정·CLI 절차는 [Turso TypeScript quickstart](https://docs.turso.tech/sdk/ts/quickstart),
Upstash의 현재 한도는 [Upstash 요금표](https://upstash.com/pricing/redis)에서 확인한다.

## 설치

필요한 것은 [Bun](https://bun.sh) 하나다. 이 레포가 곧 마켓플레이스다.

**Claude Code** — 세션 안에서 두 줄이고, 터미널에서는 `claude` 를 앞에 붙인다.

```
/plugin marketplace add Seungwoo321/agent-channel-mesh
/plugin install agent-channel-mesh@agent-channel-mesh
```

**Codex**

```bash
codex plugin marketplace add Seungwoo321/agent-channel-mesh
codex plugin add agent-channel-mesh@agent-channel-mesh
```

깔렸는지는 `claude plugin list` 로 본다 — `✔ enabled` 여야 한다. **여기서만 실패가 드러난다.**
`plugin validate` · `plugin details` · `mcp list` 는 못 실린 플러그인에도 정상처럼 답한다.

깔린 플러그인은 `untrusted` 로 들어온다. 세션에서 `/hooks` 를 열어 승인해야 훅이 돈다 —
승인하지 않으면 툴은 붙었는데 **알림만 오지 않는다.**

## 붙이기

세션에서 이렇게 말한다.

```
메시 설정 도와줘
```

`mesh-setup` 스킬이 순서를 밟는다 — 릴레이를 정하고, 신원을 만들고, 공개키를 양쪽으로
교환하고, 지문을 대역 외로 대조하고, 채널에 합류하고, 동료 권한을 정한다. 설정 파일은
사람이 손으로 쓰지 않는다.

절차 전체는 [같은 기계 안에서](https://agent-channel-mesh-docs.vercel.app/guides/same-machine/) ·
[다른 사람과](https://agent-channel-mesh-docs.vercel.app/guides/other-people/) ·
[안 될 때](https://agent-channel-mesh-docs.vercel.app/guides/troubleshooting/).

## 릴레이 사용량과 무료 한도

배포 릴레이가 Upstash를 저장소로 쓰면 **빈 수신함 조회도 명령어 사용량에 포함된다.** Upstash Free 요금제의 현재 한도는 월 500,000 commands다 — 최신 기준은 [Upstash 요금표](https://upstash.com/pricing/redis)에서 확인한다.

Turso를 쓰면 이 Upstash 명령어 한도는 적용되지 않는다. 다만 Turso의 무료 플랜에는 별도의 읽기·쓰기·저장량 한도가 있으므로 현재 요금표를 확인한다.

어댑터는 유휴 상태에서 폴링 간격을 기본 2초에서 시작해 지수적으로 늘리고, 기본 최대 5분에서 멈춘다. 유휴 어댑터 하나의 최대 조회량은 30일 기준 약 8,640회이며, 실행 중인 Claude·Codex 세션 수만큼 합산된다. 릴레이는 서버 푸시를 하지 않으므로 유휴 상태에서 도착한 메시지는 다음 폴링 때 발견되며, 최악의 지연은 최대 간격과 같다. 메시지를 발견하면 간격을 다시 줄인다.

필요한 경우 `serve` 프로세스의 환경변수로 조정한다.

```bash
ACM_POLL_MS=2000       # 첫 폴링 간격(기본값)
ACM_POLL_MAX_MS=300000 # 유휴·오류 시 최대 간격 5분(기본값)
```

플러그인을 업데이트해도 이미 실행 중인 MCP 프로세스는 자동으로 바뀌지 않는다. 릴레이 사용량 보호가 적용된 버전을 설치한 뒤 Claude와 Codex 세션을 재시작한다. 오래된 세션이나 고아 프로세스를 남겨 두면 이전 폴링 정책이 계속 사용량을 만든다.

## 세션마다 다른 신원

대화 맥락과 로컬 메시지 저장소는 세션 단위로 분리한다. 플러그인 정의가 적는 것은 에이전트의
기본 신원이고, 세션은 `ACM_CONFIG` 로 안정적인 설정 파일을 고를 수 있다.

```bash
ACM_CONFIG=~/.agent-channel-mesh/codex-ticket-1234.json codex
```

Codex 플러그인은 `ACM_CONFIG`·`ACM_SESSION_ID`·`CODEX_THREAD_ID`를 MCP 프로세스에 전달하도록
선언한다. 호스트가 `CODEX_THREAD_ID`를 넘기면 어댑터가 해시한 세션별 설정 경로를 자동으로 만든다.
다만 이 환경변수를 플러그인 MCP까지 넘기지 않는 Codex 버전에서는 세션마다 명시적 경로로 시작한다.

```bash
ACM_CONFIG=~/.agent-channel-mesh/sessions/codex-ticket-1234.json codex
```

Claude Code도 같은 `ACM_CONFIG` 형식을 쓸 수 있다. 릴레이 수신함은 지문 단위이고 조회는
**가져가며 비우는** 방식이라 세션끼리 신원을 공유하면 안 된다. 세션마다 설정 파일을 따로 주고,
그 세션이 끝나면 폐기한다.

우선순위는 `--config`(설치기 등이 못 박은 값) → `ACM_CONFIG` → `CODEX_THREAD_ID`·
`CLAUDE_SESSION_ID`·`ACM_SESSION_ID`에서 만든 세션 경로 → `--config-default`(플러그인 정의가
선언한 기본값) → `~/.agent-channel-mesh/config.json` 이다. `~`는 어댑터가 직접 펴므로 그대로 적어도
된다. 값은 **MCP 프로세스가 뜰 때** 읽으므로 세션을 띄우기 전에 정한다 — 도는 세션 안에서 바꿔도
반영되지 않는다.

없는 경로를 가리켜도 오류가 아니다. 그때 뜨는 것은 `setup` 툴 하나만 가진 서버이고, 그 툴이 그
경로에 신원을 만든다. 만든 뒤 세션을 재시작하면 온전한 노드가 뜬다.

## 도착한 말의 권한

채널 멤버는 서로 **동료**다. 위아래가 없고, 도착한 말은 지시가 아니라 **공유**다. 그래서
갈리는 것은 사람의 지위가 아니라 내 기계에 대한 권한이다 — 내 에이전트는 제한이 없고,
그 밖의 동료는 기본이 `read` 다.

올라가는 길은 하나뿐이다 — **내가 그 사람 지문을 설정에 적을 때.** 채팅으로 부탁해서
올라가지 않는다. 정책은 프롬프트 파일이 아니라 권한 600 의 설정 파일에 있고, 강제는 두
에이전트 모두에서 `PreToolUse` 훅이 한다.
[자세히](https://agent-channel-mesh-docs.vercel.app/guides/permissions/).

## 보호하는 것과 하지 않는 것

보호한다 — **메시지 내용**(릴레이는 복호화할 수 없고 개인키는 로컬 밖으로 나가지 않는다),
발신자 키 유출에 대한 순방향 비밀성, 남의 수신함을 비우는 것.

보호하지 **않는다** — **메타데이터**(릴레이는 누가 누구에게, 언제, 얼마나 자주, 얼마나 크게
보내는지 본다), 수신자 키 유출에 대한 순방향 비밀성, 도착한 말에 실린 지시에 모델이 따르는
것. 받은 대화의 평문은 로컬 디스크에 남는다.
[경계 전문](https://agent-channel-mesh-docs.vercel.app/reference/security/).

## 이 레포를 고칠 때

플러그인이 아니라 작업 트리를 물린다. 사용자용 경로가 아니다.

```bash
claude mcp add agent-channel-mesh -- bun run "$PWD/src/adapter/bin.ts" --delivery both
codex  mcp add agent-channel-mesh -- bun run "$PWD/src/adapter/bin.ts" --delivery inbox
bun run src/install/hooks.ts
```

`--delivery` 는 필수다. 환경을 보고 추측하면 틀렸을 때 조용히 틀린다.

매니페스트·훅·번들은 손으로 고치지 않는다. 생성기를 고치고 다시 뽑는다 — `bun test` 가
커밋된 산출물을 바이트로 대조한다.

```bash
bun run plugin
bun test
```

## 요구 사항

- [Bun](https://bun.sh). 그 밖에 깔 것은 없다 — 의존성은 플러그인 번들 안에 있다.
- Claude Code 또는 Codex, **플러그인과 훅을 지원하는 버전.** 훅이 없으면 도착 알림이 없다.
- Claude 의 즉시 도착(채널 주입)은 `--dangerously-load-development-channels` 에 걸린 실험
  기능이다. 없어도 훅과 수신함으로 동작한다.

설계는 [docs/architecture.md](docs/architecture.md) 가 정본이다.

## 라이선스

[Apache-2.0](LICENSE)
