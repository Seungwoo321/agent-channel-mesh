/**
 * 공개키 지문 — 128비트, PGP 워드 16단어
 *
 * 설계 근거는 docs/architecture.md §9.
 *
 * 핵심: 공격자는 자기 키를 마음대로 고를 수 있으므로 필요한 성질은
 * 충돌 저항이 아니라 **제2 역상 저항**이다. 128비트는 2¹²⁸ 작업을 요구한다.
 *
 * 잘라낸 지문을 만들지 않는다 — 16비트 접두는 8초면 갈아 맞춘다.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { EVEN, ODD } from './wordlist.js'

/** 지문 길이. 줄이지 않는다 (§9). */
export const FINGERPRINT_BYTES = 16

/**
 * 공개키에서 지문 16바이트를 산출한다.
 *
 * 이중 SHA-256 은 길이 확장 공격을 차단하고 비트코인·PGP 관행을 따른다.
 */
export function fingerprint(publicKey: Uint8Array): Uint8Array {
  return sha256(sha256(publicKey)).slice(0, FINGERPRINT_BYTES)
}

/**
 * 지문을 PGP 워드로 렌더링한다.
 *
 * 짝수 오프셋은 2음절, 홀수는 3음절 — 교대 구조가 전치·중복·누락을 검출한다.
 */
export function toWords(fp: Uint8Array): string[] {
  return Array.from(fp, (b, i) => (i % 2 === 0 ? EVEN : ODD)[b]!)
}

/**
 * PGP 워드를 지문 바이트로 되돌린다. 대조 검증에 쓴다.
 *
 * 대소문자를 무시한다 — 음성으로 받아 적은 것을 그대로 넣을 수 있어야 한다.
 * 위치에 맞는 목록에 없으면 그 자리를 짚어 던진다.
 */
export function fromWords(words: string[]): Uint8Array {
  if (words.length !== FINGERPRINT_BYTES) {
    throw new Error(`지문은 ${FINGERPRINT_BYTES}단어여야 한다 (받은 값: ${words.length})`)
  }
  return Uint8Array.from(words, (w, i) => {
    const list = i % 2 === 0 ? EVEN : ODD
    const want = i % 2 === 0 ? '2음절' : '3음절'
    const idx = list.findIndex(x => x.toLowerCase() === w.toLowerCase())
    if (idx < 0) throw new Error(`${i + 1}번째 단어 '${w}' 는 ${want} 목록에 없다`)
    return idx
  })
}

/** 대조용 hex — 4자씩 띄운다. 잘라 쓰지 않는다. */
export function toHex(fp: Uint8Array): string {
  return Array.from(fp, b => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{4})(?=.)/g, '$1 ')
}

/**
 * 정책 키로 쓰는 정규 표기 — 공백 없는 소문자 hex 32자.
 *
 * 설정 파일이 발신자별 권한을 이 값으로 건다(§8.2). 라벨이 아니라 지문인
 * 이유는 라벨이 상대가 정하는 값이라 신뢰 대상이 아니어서고(§9), key id 가
 * 아닌 이유는 사람이 대역 외로 대조하는 값이 지문이어서다 — 정책을 거는
 * 사람이 자기 눈으로 확인한 그 값이어야 한다.
 *
 * `toHex` 와 같은 값이고 공백만 없다. 잘라 쓰지 않는다.
 */
export function toKey(fp: Uint8Array): string {
  return Array.from(fp, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 사람이 적은 지문을 정규 표기로 되돌린다.
 *
 * `toHex` 는 4자씩 띄우므로 설정 파일에 그대로 붙여 넣은 값에는 공백이
 * 있다. 그것을 오타로 처리하면 정책이 조용히 안 걸린다 — 공백과 대문자는
 * 받아 주고, 길이·문자만 엄격히 본다.
 */
export function parseKey(text: string): string {
  const key = text.replace(/\s+/g, '').toLowerCase()
  if (!new RegExp(`^[0-9a-f]{${FINGERPRINT_BYTES * 2}}$`).test(key)) {
    throw new Error(`지문은 hex ${FINGERPRINT_BYTES * 2}자여야 한다 (받은 값: ${text})`)
  }
  return key
}

/**
 * 사람이 대조하는 화면 표현 — 4단어씩 4줄 + hex 한 줄.
 *
 * 전체 대조를 자연스러운 행동으로 만드는 것이 목적이다 (§9).
 */
export function format(fp: Uint8Array): string {
  const w = toWords(fp)
  // 열 너비는 가장 긴 단어(정본 최대 11글자)에 여백을 더해 정한다.
  // 고정폭으로 자르면 belowground 같은 11글자 단어가 옆 단어와 붙는다.
  const width = Math.max(...w.map(x => x.length)) + 2
  const rows: string[] = []
  for (let i = 0; i < w.length; i += 4) {
    rows.push('  ' + w.slice(i, i + 4).map(x => x.padEnd(width)).join('').trimEnd())
  }
  return `${rows.join('\n')}\n\n  fp: ${toHex(fp)}`
}
