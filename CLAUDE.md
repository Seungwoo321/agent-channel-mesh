# agent-channel-mesh

종단 간 암호화된 코딩 에이전트 메시징 메시. v1 은 Claude Code(능동 주입)와 Codex(수신함 폴링)를 지원한다. 설계는 [docs/architecture.md](docs/architecture.md) 가 정본이다.

## 규약

- **런타임은 Bun.** `bun <file>`, `bun test`, `bun install`, `bunx`. Bun 이 `.env` 를 자동 로드하므로 dotenv 를 쓰지 않는다.
- **Bun 내장 API 우선** — `Bun.serve()`(express 대신), `bun:sqlite`, `Bun.file`, 내장 `WebSocket`. 단 **암호는 예외**다(아래).
- 로컬 생성물은 `.local/`, 순수 임시 파일은 `tmp/`. 둘 다 gitignore 돼 있다.

## 암호 — 넘지 말아야 할 선

`docs/architecture.md` §10 이 근거를 갖고 확정한 사항이다. 바꾸려면 그 문서를 먼저 고친다.

- **Bun 의 `crypto.subtle` 로 X25519 를 하지 않는다.** `deriveBits({name:"X25519"})` 가 `NotSupportedError` 로 죽는다 — KEM 에 필요한 바로 그 연산이다. 반드시 `@hpke/dhkem-x25519` 를 거친다(내부에 `@noble` 을 품고 있어 subtle 을 안 탄다).
- **암호 프리미티브를 직접 조합하지 않는다.** 키 래핑은 HPKE(RFC 9180), 본문은 XChaCha20-Poly1305. X25519+HKDF+AEAD 를 손으로 엮지 않는다.
- **Double Ratchet 을 직접 구현하지 않는다.** v1 범위 밖이고, 도입한다면 `@signalapp/libsignal-client` 를 쓴다. 잘못 만든 래칫은 테스트를 통과하면서 약속한 보안을 전혀 주지 않는다.
- **본문 nonce 는 랜덤 192비트**(XChaCha20). 카운터를 쓰지 않는다 — 브릿지는 재시작되는 서브프로세스라 카운터를 잃으면 nonce 를 재사용한다.
- **지문을 잘라서 보여주지 않는다.** 16비트 접두는 8초면 갈아 맞춘다. short id 를 만들지 않는다.
- **보안 주장을 과장하지 않는다.** 메타데이터는 노출되고, 수신자 키 유출에 대한 순방향 비밀성은 없다. README 가 이미 밝히고 있으므로 약화시키지 않는다.

## 코어와 어댑터 경계

**메시 코어에 에이전트 고유 코드를 넣지 않는다.** 신원·암복호·릴레이 통신·발화 제어는 전부 에이전트 무관이어야 한다. Claude Code 든 Codex 든 같은 코어를 지나야 보안 속성이 일관된다.

에이전트별로 다른 것은 어댑터 하나뿐이고, 인터페이스는 양방향 두 개다 — 세션→메시(`send` 툴), 메시→세션(전달). 두 번째가 에이전트마다 갈린다.

- `claude/channel` 호출은 **Claude 어댑터 안에만** 존재한다. 코어에서 참조하지 않는다.
- 코어는 "메시지가 도착했다"를 어댑터에 알릴 뿐, 그것이 주입되는지 수신함에 쌓이는지 모른다.
- 어댑터는 `MeshNode` 만 쓴다. `seal`/`receive` 를 직접 부르면 검사 순서나 발화 제어를 빠뜨릴 수 있고, 그러면 에이전트마다 보안 속성이 갈린다.
- **전달 방식은 `--delivery` 로 명시한다.** 환경을 보고 추측하지 않는다 — 틀리면 "동작하는 것처럼 보이는 고장"이 된다.

## 설정 파일

어댑터의 유일한 입력이다(`~/.agent-channel-mesh/config.json`). 시드와 채널 비밀이 들어 있으므로 **권한이 600 보다 넓으면 읽지 않고 죽는다.** 이 검사를 경고 문구로 완화하지 않는다 — 이 파일 하나로 모든 암호가 무력화된다.

## 채널 프로토콜 (Claude 어댑터 한정)

- 채널은 **stdio MCP 서버**다. Claude Code 가 서브프로세스로 띄운다 — 순수 서버리스로는 세션에 닿을 수 없다.
- `meta` 키는 `[A-Za-z0-9_]` 만 유효하다. **하이픈은 조용히 삭제된다.**
- 프로토콜 동작은 `spike/channel.ts` 로 4/4 검증돼 있다(채널 등록·인바운드 주입·아웃바운드 `reply`·발신자 게이팅).
- 로컬 실행: `claude --dangerously-load-development-channels server:mesh-spike`

## 테스트

```ts
import { test, expect } from "bun:test"
```

암호 코드는 테스트 벡터로 검증한다 — round-trip 이 되는 것만으로는 보안을 증명하지 못한다.

## 커밋

에이전트는 명시적 지시 없이 커밋·푸시하지 않는다.
