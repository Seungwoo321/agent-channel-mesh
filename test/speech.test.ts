/**
 * 발화 제어 테스트
 *
 * 마지막 describe 가 본론이다 — 서로 멘션하는 두 에이전트가 실제로
 * 멈추는가. §7 이 막으려는 실패 양식이 바로 그것이고, 개별 장치가
 * 따로 통과하는 것으로는 증명되지 않는다.
 */
import { test, expect, describe } from 'bun:test'
import {
  SpeechControl,
  DEFAULT_MAX_HOPS,
  DEFAULT_MESSAGE_BUDGET,
} from '../src/channel/speech.js'

const ME = new Uint8Array(8).fill(0x11)
const OTHER = new Uint8Array(8).fill(0x22)

const control = (over: Partial<ConstructorParameters<typeof SpeechControl>[0]> = {}) =>
  new SpeechControl({ selfKeyId: ME, ...over })

const from = (text: string, hops = 0, sender = OTHER) => ({
  senderKeyId: sender,
  text,
  hops,
})

describe('에코 억제', () => {
  test('내 메시지에 응답하지 않는다', () => {
    const c = control()
    expect(c.check(from('내가 한 말', 0, ME))).toMatchObject({
      speak: false,
      reason: 'echo',
    })
  })

  test('남의 메시지에는 응답한다', () => {
    expect(control().check(from('안녕')).speak).toBe(true)
  })

  test('에코가 멘션보다 먼저다 — 나를 부른 내 메시지도 막는다', () => {
    const c = control({ mentions: ['alice'] })
    expect(c.check(from('@alice 확인해줘', 0, ME))).toMatchObject({ reason: 'echo' })
  })
})

describe('멘션 기반 발화', () => {
  test('멘션 목록이 비면 모든 메시지에 응답한다 — 1:1 기본값', () => {
    expect(control().check(from('아무 말')).speak).toBe(true)
  })

  test('나를 부르면 응답한다', () => {
    const c = control({ mentions: ['alice'] })
    expect(c.check(from('@alice 이거 봐줄래')).speak).toBe(true)
  })

  test('안 부르면 침묵한다 — 읽되 응답하지 않는다', () => {
    const c = control({ mentions: ['alice'] })
    expect(c.check(from('둘이 얘기 중'))).toMatchObject({
      speak: false,
      reason: 'not-mentioned',
    })
  })

  test('@ 없이 이름만 있어도 인정한다', () => {
    const c = control({ mentions: ['alice'] })
    expect(c.check(from('alice, 확인 부탁해')).speak).toBe(true)
  })

  test('대소문자를 무시한다', () => {
    const c = control({ mentions: ['alice'] })
    expect(c.check(from('@ALICE 봐줘')).speak).toBe(true)
    expect(c.check(from('@Alice 봐줘')).speak).toBe(true)
  })

  test('다른 이름의 일부는 멘션이 아니다 — 오인이 곧 무한 왕복', () => {
    const c = control({ mentions: ['alice'] })
    // alice-bot 을 부른 것을 alice 가 자기 호출로 오인하면 안 된다.
    expect(c.check(from('@alice-bot 처리해줘'))).toMatchObject({ reason: 'not-mentioned' })
    expect(c.check(from('malice 라는 단어'))).toMatchObject({ reason: 'not-mentioned' })
  })

  test('구두점 뒤의 이름은 멘션이다', () => {
    const c = control({ mentions: ['alice'] })
    expect(c.check(from('alice, 봐줘')).speak).toBe(true)
    expect(c.check(from('(alice) 확인')).speak).toBe(true)
  })

  test('한글 이름도 경계를 지킨다', () => {
    const c = control({ mentions: ['앨리스'] })
    expect(c.check(from('@앨리스 확인해줘')).speak).toBe(true)
    expect(c.check(from('앨리스, 봐줘')).speak).toBe(true)
    // 더 긴 이름의 일부면 아니다.
    expect(c.check(from('@앨리스봇 처리'))).toMatchObject({ reason: 'not-mentioned' })
  })

  test('여러 이름 중 하나만 맞아도 응답한다', () => {
    const c = control({ mentions: ['alice', '앨리스'] })
    expect(c.check(from('@앨리스 봐줘')).speak).toBe(true)
    expect(c.check(from('@alice 봐줘')).speak).toBe(true)
  })
})

describe('홉 제한', () => {
  test('상한 아래면 응답한다', () => {
    expect(control().check(from('x', DEFAULT_MAX_HOPS - 1)).speak).toBe(true)
  })

  test('상한에 닿으면 사람에게 넘긴다', () => {
    const d = control().check(from('x', DEFAULT_MAX_HOPS))
    expect(d).toMatchObject({ speak: false, reason: 'hop-limit' })
    if (!d.speak) expect(d.detail).toContain('사람')
  })

  test('응답하면 홉이 하나 는다', () => {
    const d = control().check(from('x', 3))
    expect(d).toMatchObject({ speak: true, hops: 4 })
  })

  test('상한을 낮출 수 있다', () => {
    const c = control({ maxHops: 2 })
    expect(c.check(from('x', 1)).speak).toBe(true)
    expect(c.check(from('x', 2))).toMatchObject({ reason: 'hop-limit' })
  })

  test('홉이 없으면 0 으로 본다 — 사슬의 시작', () => {
    expect(control().check({ senderKeyId: OTHER, text: 'x' })).toMatchObject({
      speak: true,
      hops: 1,
    })
  })
})

describe('예산', () => {
  test('쓴 만큼 줄어든다', () => {
    const c = control({ messageBudget: 3 })
    expect(c.remaining).toBe(3)
    c.spend()
    expect(c.remaining).toBe(2)
    expect(c.used).toBe(1)
  })

  test('소진하면 정지한다', () => {
    const c = control({ messageBudget: 2 })
    expect(c.check(from('x')).speak).toBe(true)
    c.spend()
    expect(c.check(from('x')).speak).toBe(true)
    c.spend()
    expect(c.check(from('x'))).toMatchObject({ speak: false, reason: 'budget' })
  })

  test('판정만으로는 예산이 줄지 않는다 — 취소된 발화를 물리지 않는다', () => {
    const c = control({ messageBudget: 2 })
    c.check(from('x'))
    c.check(from('x'))
    c.check(from('x'))
    expect(c.remaining).toBe(2)
  })

  test('reset 으로 되돌린다', () => {
    const c = control({ messageBudget: 1 })
    c.spend()
    expect(c.check(from('x')).speak).toBe(false)
    c.reset()
    expect(c.check(from('x')).speak).toBe(true)
  })

  test('기본 예산이 걸려 있다', () => {
    const c = control()
    expect(c.remaining).toBe(DEFAULT_MESSAGE_BUDGET)
  })
})

describe('검사 순서', () => {
  test('예산이 홉보다 먼저다 — 둘 다 걸리면 예산', () => {
    const c = control({ messageBudget: 1, maxHops: 2 })
    c.spend()
    expect(c.check(from('x', 5))).toMatchObject({ reason: 'budget' })
  })

  test('홉이 멘션보다 먼저다 — 본문 스캔이 가장 비싸다', () => {
    const c = control({ mentions: ['alice'], maxHops: 1 })
    expect(c.check(from('나를 안 부른 긴 메시지', 5))).toMatchObject({ reason: 'hop-limit' })
  })
})

describe('무한 왕복이 실제로 멈추는가 — §7 의 목적', () => {
  test('서로 멘션하는 두 에이전트가 홉 상한에서 멈춘다', () => {
    // 이게 §7 이 막으려는 바로 그 실패 양식이다.
    const A = new Uint8Array(8).fill(0xaa)
    const B = new Uint8Array(8).fill(0xbb)
    const a = new SpeechControl({ selfKeyId: A, mentions: ['alice'], maxHops: 4 })
    const b = new SpeechControl({ selfKeyId: B, mentions: ['bob'], maxHops: 4 })

    let hops = 0
    let turn = 0
    // 서로를 계속 부르는 최악의 경우.
    for (; turn < 100; turn++) {
      const [speaker, sender, text] =
        turn % 2 === 0 ? [b, A, '@bob 확인해줘'] : [a, B, '@alice 확인해줘']
      const d = speaker.check({ senderKeyId: sender, text, hops })
      if (!d.speak) break
      speaker.spend()
      hops = d.hops
    }

    expect(turn).toBeLessThan(100)
    expect(hops).toBe(4)
  })

  test('홉을 위조해도 예산이 뒤를 받친다', () => {
    // 악의적·버그 있는 상대가 홉을 늘 0 으로 보내면 홉 제한은 무력하다.
    // 그때 총량이 막아야 한다.
    const c = control({ messageBudget: 5, maxHops: 3 })
    let spoke = 0
    for (let i = 0; i < 100; i++) {
      if (!c.check(from('@me 또 불러', 0)).speak) break
      c.spend()
      spoke++
    }
    expect(spoke).toBe(5)
  })

  test('멘션 없는 채널에서도 예산이 상한을 준다', () => {
    // 멘션 목록이 비면 모든 메시지에 응답하므로 홉·예산만 남는다.
    const c = control({ messageBudget: 3 })
    let spoke = 0
    for (let i = 0; i < 50; i++) {
      if (!c.check(from('아무 말', 0)).speak) break
      c.spend()
      spoke++
    }
    expect(spoke).toBe(3)
  })
})
