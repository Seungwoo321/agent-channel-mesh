/**
 * 워드 리스트·지문 테스트
 *
 * 정본 벡터가 이 파일의 존재 이유다 — 워드 리스트는 알파벳순으로 정렬된
 * 사본이 인터넷에 널려 있고, 그건 바이트 값 순서인 정본과 다르다.
 * 벡터 없이는 그럴듯하게 틀린 목록을 넣고도 모른다.
 */
import { test, expect, describe } from 'bun:test'
import { EVEN, ODD } from '../src/identity/wordlist.js'
import {
  fingerprint,
  toWords,
  fromWords,
  toHex,
  format,
  FINGERPRINT_BYTES,
} from '../src/identity/fingerprint.js'

describe('워드 리스트 — 정본 대조', () => {
  test('Zimmermann 문서의 벡터와 일치한다', () => {
    // https://philzimmermann.com/docs/PGP_word_list.pdf
    const hex = 'E58294F2E9A227486E8B061B31CC528FD7FA3F19'
    const bytes = Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16))
    expect(toWords(bytes).join(' ')).toBe(
      'topmost Istanbul Pluto vagabond treadmill Pacific brackish dictator ' +
        'goldfish Medusa afflict bravado chatter revolver Dupont midsummer ' +
        'stopwatch whimsical cowbell bottomless',
    )
  })

  test('바이트 순서가 단어를 바꾼다 — E582 와 82E5', () => {
    // 같은 두 바이트라도 순서가 다르면 완전히 다른 단어가 된다.
    expect(toWords(Uint8Array.of(0xe5, 0x82)).join(' ')).toBe('topmost Istanbul')
    expect(toWords(Uint8Array.of(0x82, 0xe5)).join(' ')).toBe('miser travesty')
  })

  test('두 목록 모두 256개이고 중복·교집합이 없다', () => {
    expect(EVEN).toHaveLength(256)
    expect(ODD).toHaveLength(256)
    expect(new Set(EVEN).size).toBe(256)
    expect(new Set(ODD).size).toBe(256)
    expect(EVEN.filter(w => ODD.includes(w))).toEqual([])
  })

  test('글자수 상한을 지킨다 — 짝수 9, 홀수 11', () => {
    expect(Math.max(...EVEN.map(w => w.length))).toBe(9)
    expect(Math.max(...ODD.map(w => w.length))).toBe(11)
  })

  test('ODD 는 알파벳순이 아니다 — 정렬된 사본은 정본이 아니다', () => {
    // 흔한 실수: 인터넷의 사본은 두 목록을 각각 알파벳순으로 정렬해 둔다.
    // EVEN 은 정본도 우연히 알파벳순이지만 ODD 는 아니다 (0x00 adroitness
    // 다음이 adviser, 그다음이 aggregate 가 아니라 alkali).
    expect(ODD).not.toEqual([...ODD].sort((a, b) => a.localeCompare(b)))
  })
})

describe('지문', () => {
  const key = new Uint8Array(32).fill(7)

  test('128비트다', () => {
    expect(fingerprint(key)).toHaveLength(16)
    expect(FINGERPRINT_BYTES).toBe(16)
  })

  test('결정적이다', () => {
    expect(fingerprint(key)).toEqual(fingerprint(key))
  })

  test('입력이 1비트만 달라도 완전히 달라진다', () => {
    const other = new Uint8Array(32).fill(7)
    other[31] = other[31]! ^ 0x01
    expect(fingerprint(key)).not.toEqual(fingerprint(other))
  })

  test('이중 SHA-256 이다', async () => {
    const { sha256 } = await import('@noble/hashes/sha2.js')
    expect(fingerprint(key)).toEqual(sha256(sha256(key)).slice(0, 16) as Uint8Array)
  })
})

describe('워드 왕복', () => {
  const fp = fingerprint(new Uint8Array(32).fill(42))

  test('16단어로 표현된다', () => {
    expect(toWords(fp)).toHaveLength(16)
  })

  test('되돌리면 원본이다', () => {
    expect(fromWords(toWords(fp))).toEqual(fp)
  })

  test('대소문자를 무시한다 — 받아 적은 것을 그대로 넣는다', () => {
    const words = toWords(fp)
    expect(fromWords(words.map(w => w.toUpperCase()))).toEqual(fp)
    expect(fromWords(words.map(w => w.toLowerCase()))).toEqual(fp)
  })

  test('전치를 검출한다 — 교대 구조의 목적', () => {
    const words = toWords(fp)
    const swapped = [...words]
    ;[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!]
    // 2음절 자리에 3음절 단어가 오므로 목록에 없다.
    expect(() => fromWords(swapped)).toThrow()
  })

  test('단어 수가 틀리면 거부한다', () => {
    expect(() => fromWords(toWords(fp).slice(0, 15))).toThrow(/16단어/)
  })

  test('모르는 단어는 위치를 짚어 거부한다', () => {
    const words = toWords(fp)
    words[4] = 'nonexistentword'
    expect(() => fromWords(words)).toThrow(/5번째/)
  })
})

describe('표시', () => {
  const fp = fingerprint(new Uint8Array(32).fill(1))

  test('hex 는 4자씩 띄우고 전체를 보여준다', () => {
    const hex = toHex(fp)
    expect(hex.replace(/ /g, '')).toHaveLength(32)
    expect(hex.split(' ')).toHaveLength(8)
  })

  test('4줄 + hex 로 배치한다', () => {
    const lines = format(fp).split('\n')
    expect(lines.filter(l => l.trim() && !l.includes('fp:'))).toHaveLength(4)
    expect(format(fp)).toContain('fp:')
  })

  test('가장 긴 단어가 옆 단어와 붙지 않는다', () => {
    // 11글자 ODD 단어(belowground 등)를 고정 11폭으로 찍으면 옆과 붙는다.
    // 모든 단어가 공백으로 분리돼 되읽을 수 있어야 한다.
    const longest = ODD.reduce((a, b) => (b.length > a.length ? b : a))
    const idx = ODD.indexOf(longest)
    const withLong = Uint8Array.from({ length: 16 }, (_, i) => (i % 2 === 1 ? idx : 0))
    const body = format(withLong)
      .split('\n')
      .filter(l => l.trim() && !l.includes('fp:'))
      .join(' ')
    expect(body.trim().split(/\s+/)).toEqual(toWords(withLong))
  })
})
