/**
 * 서브프로세스로 띄운 어댑터를 MCP 로 두드리는 하네스.
 *
 * 배선은 `main()` 을 실제로 통과해야 보인다 — 테스트가 `serve()`·`serveSetup()`
 * 을 직접 부르면 인자 해석·설정 유무 분기·툴 목록 조립이 전부 우회된다.
 * 그래서 여기서는 진짜 프로세스를 띄우고 stdin/stdout 으로만 말을 건다.
 */
import { join } from 'node:path'

export const REPO = join(import.meta.dir, '..', '..')
export const BIN = join(REPO, 'src/adapter/bin.ts')

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface Rpc {
  readonly id?: number
  readonly method?: string
  readonly result?: Record<string, unknown>
  readonly error?: { readonly message: string }
}

export class Adapter {
  private nextId = 1
  private readonly buffered: Rpc[] = []
  private pending = ''
  private readonly chunks: AsyncIterator<Uint8Array>
  private readonly decoder = new TextDecoder()

  private constructor(private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>) {
    this.chunks = proc.stdout[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>
  }

  static async start(args: readonly string[], home: string): Promise<Adapter> {
    const proc = Bun.spawn(['bun', BIN, ...args], {
      cwd: REPO,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: home, ACM_CONFIG: undefined, ACM_DELIVERY: undefined },
    })
    const adapter = new Adapter(proc as Bun.Subprocess<'pipe', 'pipe', 'pipe'>)
    const init = await adapter.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'acceptance', version: '0' },
    })
    adapter.notify('notifications/initialized')
    adapter.initializeResult = init
    return adapter
  }

  initializeResult: Record<string, unknown> = {}

  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    this.write({ jsonrpc: '2.0', id, method, params })
    const res = await this.readUntil(m => m.id === id)
    if (res.error) throw new Error(`${method} 실패: ${res.error.message}`)
    return res.result ?? {}
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** `tools/list` 가 낸 이름들. 정렬해 비교에 그대로 쓴다. */
  async toolNames(): Promise<string[]> {
    const listed = await this.request('tools/list')
    return (listed.tools as { name: string }[]).map(t => t.name).sort()
  }

  /** 툴 호출 결과의 평문. MCP `content` 껍질을 벗긴다. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args })
    const content = res.content as { type: string; text: string }[]
    return content.map(c => c.text).join('\n')
  }

  /** 평문과 오류 여부를 함께 본다. 거부를 확인하는 자리에서 쓴다. */
  async callResult(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> {
    const res = await this.request('tools/call', { name, arguments: args })
    const content = res.content as { type: string; text: string }[]
    return { text: content.map(c => c.text).join('\n'), isError: res.isError === true }
  }

  private write(message: Record<string, unknown>): void {
    this.proc.stdin.write(JSON.stringify(message) + '\n')
    this.proc.stdin.flush()
  }

  private async readUntil(match: (m: Rpc) => boolean, timeoutMs = 15_000): Promise<Rpc> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.buffered.findIndex(match)
      if (found >= 0) return this.buffered.splice(found, 1)[0]!
      if (Date.now() > deadline) throw new Error('어댑터가 응답하지 않았다')
      const chunk = await Promise.race([
        this.chunks.next(),
        sleep(timeoutMs).then(() => ({ done: true, value: undefined }) as const),
      ])
      if (chunk.done || chunk.value === undefined) throw new Error('어댑터가 stdout 을 닫았다')
      this.pending += this.decoder.decode(chunk.value, { stream: true })
      let nl: number
      while ((nl = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, nl).trim()
        this.pending = this.pending.slice(nl + 1)
        if (line) this.buffered.push(JSON.parse(line) as Rpc)
      }
    }
  }

  async stop(): Promise<void> {
    this.proc.kill()
    await this.proc.exited
  }
}
