// Tests for permission-mcp.ts, the small MCP server Claude Code calls when a
// headless run needs permission. It is run as a real process and spoken to
// over stdin/stdout, with a stand-in for the bridge's local endpoint.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const script = join(import.meta.dir, 'permission-mcp.ts')

function start(bridgeUrl: string) {
  const proc = Bun.spawn(['bun', script], {
    env: { ...process.env, BRIDGE_URL: bridgeUrl, BRIDGE_CHAT: 'chat-1' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const lines: any[] = []
  const waiters: Array<() => void> = []
  void (async () => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const part of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(part, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)))
        buf = buf.slice(nl + 1)
        waiters.splice(0).forEach(w => w())
      }
    }
  })()
  const call = async (id: number, method: string, params?: unknown) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    proc.stdin.flush()
    for (;;) {
      const found = lines.find(l => l.id === id)
      if (found) return found
      await Promise.race([new Promise<void>(r => waiters.push(r)), Bun.sleep(100)])
    }
  }
  return { proc, call }
}

/** A stand-in for the bridge: stays "pending" once, then gives the verdict. */
function fakeBridge(decision: object) {
  const seen: any[] = []
  let waits = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/approve') {
        seen.push(await req.json())
        return Response.json({ id: 'req-1' })
      }
      if (url.pathname === '/wait') return Response.json(++waits === 1 ? { pending: true } : { decision })
      return new Response('nf', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const toolCall = { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'docker restart x' }, tool_use_id: 't1' } }
const verdict = (response: any) => JSON.parse(response.result.content[0].text)

describe('permission-mcp', () => {
  test('speaks enough MCP for Claude Code: initialize, list the one tool, ping', async () => {
    const bridge = fakeBridge({ behavior: 'allow' })
    const mcp = start(bridge.url)
    const init = await mcp.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities).toEqual({ tools: {} })
    const tools = await mcp.call(2, 'tools/list')
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(['approve'])
    expect((await mcp.call(3, 'ping')).result).toEqual({})
    expect((await mcp.call(4, 'no/such/method')).error.code).toBe(-32601)
    mcp.proc.kill()
    bridge.stop()
  })

  test('allow: asks the bridge, waits through "pending", and returns the approved input', async () => {
    const bridge = fakeBridge({ behavior: 'allow' })
    const mcp = start(bridge.url)
    const v = verdict(await mcp.call(1, 'tools/call', toolCall))
    expect(v).toEqual({ behavior: 'allow', updatedInput: { command: 'docker restart x' } })
    expect(bridge.seen[0]).toEqual({ chat: 'chat-1', tool_name: 'Bash', input: { command: 'docker restart x' } })
    mcp.proc.kill()
    bridge.stop()
  })

  test('deny is passed on with its reason', async () => {
    const bridge = fakeBridge({ behavior: 'deny', message: 'The user denied this on Discord.' })
    const mcp = start(bridge.url)
    expect(verdict(await mcp.call(1, 'tools/call', toolCall))).toEqual({
      behavior: 'deny',
      message: 'The user denied this on Discord.',
    })
    mcp.proc.kill()
    bridge.stop()
  })

  test('if the bridge cannot be reached, the answer is deny, never allow', async () => {
    const mcp = start('http://127.0.0.1:9') // nothing listens there
    const v = verdict(await mcp.call(1, 'tools/call', toolCall))
    expect(v.behavior).toBe('deny')
    mcp.proc.kill()
    const none = start('')
    expect(verdict(await none.call(1, 'tools/call', toolCall)).behavior).toBe('deny')
    none.proc.kill()
  })
})
