/**
 * 묶음 렌더 — 밀린 메시지를 종합 보고로 바꾼다
 *
 * 설계 근거는 docs/architecture.md §6.1「밀린 메시지는 종합 보고로 전달한다」.
 *
 * 전달은 완전 비동기라 며칠 접속하지 않으면 그 사이의 것이 큐에 쌓인다.
 * 그 묶음을 **도착 순서대로 하나씩 던지면 안 된다** — 팀원이 "스키마 A 로
 * 간다"고 했다가 다음 날 "A 는 막혀서 B" 로 정정했는데 첫 건에 반사적으로
 * 답하면 **이미 뒤집힌 전제로 일한다.** §7 홉 제한이 왕복을 끊으므로
 * 정정할 기회도 제한된다.
 *
 * 그래서 §6.1 이 요구하는 셋을 여기서 강제한다.
 *
 *   - 채널별로 묶고 시간순으로 정렬해 **한 덩어리로** 제시한다.
 *   - 각 메시지에 발신자·채널·**절대 시각**을 붙인다. `3시간 전` 같은 상대
 *     시각은 쓰지 않는다 — 며칠 밀린 상황에서 오독을 부른다.
 *   - 2건 이상이면 묶음 머리에 즉답 금지 지시를 넣는다.
 *
 * **프롬프트 권고가 아니라 구조적 강제다**(§6.1 · §6.6). 보고 형식을
 * 지시문으로 주입하면 컨텍스트가 압축될 때 사라지고 모델이 무시해도 막을 수
 * 없다. 모델에게 도달하는 형태 자체가 이미 시간순 묶음이어야 한다.
 */
import type { StoredMessage } from '../store/store.js'
import type { Grant } from '../policy/authority.js'
import { DEFAULT_PEER_GRANT, recordAuthority, recordGrant } from '../policy/authority.js'

/**
 * 묶음 머리에 붙는 지시 (§6.1).
 *
 * 문구를 상수로 두는 이유는 이것이 **계약**이기 때문이다 — 어댑터가 이걸
 * 붙였는지를 밖에서 확인할 수 있어야 "구조적 강제"라는 말이 검증 가능해진다.
 */
export const BUNDLE_HEAD = '먼저 전체를 읽고 현재 상태를 보고한다. 개별 메시지에 즉답하지 않는다.'

/**
 * 한 건에 붙는 표시.
 *
 * 상수로 두는 이유는 {@link BUNDLE_HEAD} 와 같다 — 이 문구가 곧 `mesh-usage`
 * 스킬이 모델에게 뜻을 알려 주는 어휘이고, 여기서 바꾸면 스킬이 없는 표시를
 * 설명하게 된다. 어긋남은 `test/plugin.test.ts` 가 잡는다.
 */
export const MARK_NEW = '[새 메시지]'
export const MARK_SELF = '[내 에이전트]'
export const MARK_MUTE = '응답 안 함'

/** 동료가 공유한 말의 표시. 기본 권한이면 등급을 적지 않는다. */
export function markPeer(grant: Grant): string {
  return grant === DEFAULT_PEER_GRANT ? '[동료 공유]' : `[동료 공유 · 허용 ${grant}]`
}

export interface BundleOptions {
  /** 머리 지시를 붙일지. 생략하면 메시지가 2건 이상일 때 붙는다 (§6.1). */
  readonly head?: boolean
  /**
   * 미전달분에 새 메시지 표시를 붙일지. `inbox` 툴 전용이다.
   *
   * 저장소가 정본이라 `inbox` 는 이미 주입된 것도 함께 내준다(§4). 그때
   * 무엇이 아직 세션에 안 닿았는지가 안 보이면, 모델은 다 본 것과 처음 보는
   * 것을 구별하지 못한다. 주입 경로에는 미전달분만 가므로 표시가 무의미하다.
   */
  readonly markNew?: boolean
}

/** 채널 하나로 묶인 덩어리. 묶음의 순서 규칙(§6.1)을 한 곳에서 정한다. */
export interface ChannelGroup {
  readonly channelId: string
  readonly messages: readonly StoredMessage[]
}

/**
 * 저장된 기록을 §6.1 묶음으로 렌더한다.
 *
 * 비면 빈 문자열이다 — "없다"는 말은 호출부가 자기 맥락에 맞게 한다.
 */
export function renderBundle(
  messages: readonly StoredMessage[],
  options: BundleOptions = {},
): string {
  if (messages.length === 0) return ''

  const body = groupByChannel(messages)
    .flatMap(group => group.messages.map(m => renderOne(m, options.markNew === true)))
    .join('\n\n')

  // 기본 조건은 2건 이상이다 — 한 건뿐이면 "전체를 읽으라"는 지시가 가리킬
  // 전체가 없고, 지시가 늘 붙어 있으면 모델이 그것을 배경으로 흘려 듣는다.
  const head = options.head ?? messages.length >= 2
  return head ? `${BUNDLE_HEAD}\n\n${body}` : body
}

/**
 * 채널별로 묶는다. 그룹 순서는 **그 그룹의 가장 이른 메시지** 기준이다.
 *
 * 저장소가 이미 시간순으로 돌려주지만 방어적으로 다시 정렬한다 — 이 함수는
 * 저장소 밖(주입 배치의 합류분 등)에서 모인 배열도 받고, 순서가 어긋난 채
 * 렌더되면 §6.1 이 막으려는 "뒤집힌 전제로 일하기"가 그대로 재현된다.
 *
 * 주입 경로도 이 그룹 단위를 쓴다 — `claude/channel` 의 `meta.chat_id` 는
 * 하나뿐이라 채널을 섞으면 §6 대화 단위 격리가 깨진다.
 */
export function groupByChannel(messages: readonly StoredMessage[]): ChannelGroup[] {
  const groups = new Map<string, StoredMessage[]>()
  for (const m of messages) {
    const bucket = groups.get(m.channelId)
    if (bucket) bucket.push(m)
    else groups.set(m.channelId, [m])
  }

  const out: ChannelGroup[] = []
  for (const [channelId, bucket] of groups) {
    sortByTime(bucket)
    out.push({ channelId, messages: bucket })
  }
  out.sort((a, b) => compareTime(a.messages[0]!, b.messages[0]!))
  return out
}

/**
 * 사람이 부르는 발신자 이름.
 *
 * 라벨은 **신뢰의 근거가 아니다**(§9) — 멤버 목록에 적힌 이름일 뿐이다.
 * 없으면 key id hex 를 그대로 보여준다. 잘라 보여주지 않는 것과 같은 이유로
 * (§9) 여기서도 축약하지 않는다.
 */
export function senderOf(m: StoredMessage): string {
  if (m.direction === 'out') return '(나)'
  return m.senderLabel ?? m.senderKeyId ?? '(알 수 없음)'
}

/** 공백 없는 평문 hex. 저장소 id·key id 처럼 **값으로 쓰는** 자리에 쓴다. */
export function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/**
 * 한 건.
 *
 * 시각을 **보낸 것과 저장한 것 둘 다** 적는다. `sentAt` 은 발신자가 정하는
 * 값이라 신뢰 대상이 아니고(src/node/node.ts:51-52), 그것만 보여주면 발신자가
 * 시각을 조작해 순서 인식을 흔들 수 있다. `storedAt` 은 내가 남긴 값이라
 * 대조 기준이 된다.
 */
function renderOne(m: StoredMessage, markNew: boolean): string {
  const when = `보낸 ${iso(m.sentAt)} · 저장 ${iso(m.storedAt)}`
  // 발화 판정을 함께 보여준다 — 메시지는 판정과 무관하게 전달되고(§7
  // 「읽되 응답하지 않는다」), 응답 여부는 모델이 이걸 보고 정한다.
  const mute = m.mute === undefined ? '' : ` [${MARK_MUTE}: ${m.mute}]`
  const fresh = markNew && !m.delivered ? ` ${MARK_NEW}` : ''
  return `<${senderOf(m)}@${m.channelId} · ${when}>${authorityOf(m)}${mute}${fresh}\n${m.text}`
}

/**
 * 이 한 건이 내 기계에서 갖는 자리 (§8).
 *
 * 동료의 말은 **공유**다 — 위아래가 아니라 옆의 동료가 알려 준 것이고, 그래서
 * 표시도 "지시가 왔다"가 아니라 "동료가 공유했다"로 적는다. 나누는 것은 사람의
 * 지위가 아니라 **내 기계에 대한 권한**이다.
 *
 * 이 표시는 **강제가 아니다.** 실제로 막는 것은 `PreToolUse` 훅이고(§8.3),
 * 여기 문자열은 모델이 자기 상황을 알게 하는 예의다 — 지시문으로 정책을
 * 주입하면 압축될 때 사라지므로(§6.1) 표시에 기대지 않는다.
 */
function authorityOf(m: StoredMessage): string {
  if (recordAuthority(m) === 'self') return ` ${MARK_SELF}`
  return ` ${markPeer(recordGrant(m))}`
}

/** 절대 시각만 쓴다 (§6.1). 상대 시각은 며칠 밀린 묶음에서 오독을 부른다. */
function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * 시간순(오름차순). 같은 시각이면 저장 순, 그다음 id.
 *
 * 저장소(src/store/store.ts)의 정렬과 같은 규칙이다. 거기 것은 private 이고
 * 여기 입력은 저장소를 안 거친 배열일 수도 있어 각자 갖는다 — 규칙이 갈리면
 * 같은 묶음이 경로에 따라 다른 순서로 보인다.
 */
function sortByTime(messages: StoredMessage[]): void {
  messages.sort(compareTime)
}

function compareTime(a: StoredMessage, b: StoredMessage): number {
  return a.sentAt - b.sentAt || a.storedAt - b.storedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
