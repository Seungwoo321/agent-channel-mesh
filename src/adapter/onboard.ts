/**
 * 온보딩 — 사람이 시작할 수 있게 한다
 *
 * 설계 근거는 docs/architecture.md §11「설정」.
 *
 * 설정 파일은 어댑터의 유일한 입력이지만(§11), 그 안에 들어갈 값은 전부
 * 32바이트 hex 다. 사람이 손으로 만들 수 있는 값이 아니다 — 만들 수단이
 * 없으면 문서에 적힌 사용법이 실행 불가능한 문장이 된다.
 *
 * 여기 있는 것은 두 가지뿐이다.
 *   - `init`   — 시드를 만들고 설정 뼈대를 0600 으로 쓴다
 *   - `whoami` — 상대에게 보낼 공개키와, 사람이 대조할 지문을 보여준다
 *
 * 채널 비밀 교환 자체는 아직 사람이 한다. 그것을 자동화하려면 초대 프로토콜이
 * 필요하고, 그건 별도 설계다 — 여기서는 "손으로 할 수 있게" 까지만 한다.
 */
import { deriveIdentity, generateSeed, type Identity } from '../identity/keys.js'
import { format } from '../identity/fingerprint.js'
import { CHANNEL_SECRET_BYTES } from '../channel/channel.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { expandHome, type Config } from './config.js'

/** 바이트를 hex 로. 설정 파일이 쓰는 형식이다 — 지문 표기(§9)와 다르다. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** 새 설정 뼈대. 채널은 비워 둔다 — 상대 공개키 없이는 채널을 만들 수 없다. */
export function skeleton(seed: Uint8Array, relay?: string, relayToken?: string): Config {
  return {
    seed: hex(seed),
    ...(relay ? { relay } : {}),
    ...(relayToken ? { relayToken } : {}),
    channels: [],
  }
}

export interface InitResult {
  readonly path: string
  readonly identity: Identity
  /** 이미 있는 파일을 건드리지 않고 끝냈으면 true. */
  readonly existed: boolean
}

export interface InitOptions {
  readonly relay?: string
  /**
   * 릴레이 쓰기 토큰 (§10.13). 환경변수 `ACM_RELAY_TOKEN` 에서 온다.
   *
   * 플래그로 받지 않는 이유는 `ps` 에 그대로 찍히기 때문이다 — 같은 기계의
   * 다른 사용자가 프로세스 목록만 보고 토큰을 가져간다.
   */
  readonly relayToken?: string
  /** 파일 존재 확인. 테스트에서만 주입한다. */
  readonly exists?: (path: string) => Promise<boolean>
  /** 0600 으로 파일을 쓴다. 테스트에서만 주입한다. */
  readonly write?: (path: string, text: string) => Promise<void>
}

/**
 * 설정을 만든다.
 *
 * **이미 있으면 덮어쓰지 않는다.** 그 파일에는 되찾을 수 없는 시드가 들어
 * 있다 — 덮어쓰는 순간 신원이 사라지고, 상대가 대조해 둔 지문(§9)이 전부
 * 무효가 된다. 실수 한 번의 대가가 너무 크므로 아예 막는다.
 */
export async function init(path: string, options: InitOptions = {}): Promise<InitResult> {
  const file = expandHome(path)
  const exists = options.exists ?? (async (p: string) => await Bun.file(p).exists())
  const write = options.write ?? defaultWrite

  const seed = generateSeed()
  const identity = await deriveIdentity(seed)

  if (await exists(file)) {
    // 있는 파일의 신원을 보여줘야 하지만, 그건 whoami 의 일이다.
    return { path: file, identity, existed: true }
  }

  await write(file, JSON.stringify(skeleton(seed, options.relay, options.relayToken), null, 2) + '\n')
  return { path: file, identity, existed: false }
}

/** 상위 폴더까지 만들고 0600 으로 쓴다. 넓은 권한으로 만들면 어댑터가 거부한다(§11). */
async function defaultWrite(path: string, text: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, text, { mode: 0o600 })
}

/** 새 채널 비밀. 채널을 여는 쪽이 만들어 멤버에게 전달한다(§10.11). */
export function newChannelSecret(): string {
  return hex(randomBytes(CHANNEL_SECRET_BYTES))
}

/**
 * 상대에게 보낼 내 정보.
 *
 * 공개키는 그대로 전달해도 되지만 **지문은 대역 외로 대조해야 한다**(§9) —
 * 같은 경로로 온 공개키와 지문은 서로를 검증하지 못한다.
 */
export function whoami(identity: Identity, label = '내이름'): string {
  return [
    '상대 설정의 members 에 넣을 값:',
    '',
    JSON.stringify(
      { label, sign: hex(identity.signPublicKey), kem: hex(identity.kemPublicKey) },
      null,
      2,
    ),
    '',
    '내 지문 — 다른 경로(음성·대면)로 대조한다. 이 값이 어긋나면 중간자다:',
    '',
    format(identity.fingerprint),
  ].join('\n')
}
