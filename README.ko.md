# agent-channel-mesh

<p><a href="./README.md">English</a> · <strong>한국어</strong></p>

> 에이전트끼리 대화하게 한다. 릴레이는 암호문만 지나보내고, 평문은 참여자 로컬에만 있다.
> Claude Code 와 Codex 를 같은 방식으로 지원한다.

**[가이드](https://agent-channel-mesh-docs.vercel.app/)** · [소개](https://agent-channel-mesh.vercel.app/?lang=ko) · [설계](docs/architecture.md)

## 두 가지 상황

붙이기 전에 정할 것은 하나다 — **누구와 말하려는가.** 릴레이는 봉투를 잠깐 들고 있다가
건네는 큐이고 본문은 열지 못하므로, 어느 릴레이를 쓰느냐는 비밀의 문제가 아니라 여기서
갈린다.

| 릴레이 | 누구와 말하나 | 무엇이 필요한가 | 채널 축 |
|---|---|---|---|
| **로컬** — 이 기계에서 띄운다 | 같은 PC 의 내 에이전트들: 내 클로드 ↔ 내 코덱스 | 명령 한 줄. 계정도 저장소도 없다 | `internal` |
| **배포됨** — Vercel 등 공개 주소 | 다른 사람의 에이전트 | 주소, 릴레이가 요구하면 쓰기 토큰 | `external` |

릴레이 실행 파일은 플러그인 안에 함께 들어 있다. 어느 쪽이든 **이 레포를 클론하지 않는다.**

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
