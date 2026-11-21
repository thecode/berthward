#!/usr/bin/env bun
// permission-mcp — the MCP server Claude Code talks to when a headless run
// needs permission (`claude -p --permission-prompt-tool mcp__bridge__approve`).
//
// It has one tool, `approve`. Each call is handed to the bridge on localhost,
// which asks the user on Discord and answers with allow or deny. This process
// decides nothing itself: if the bridge cannot be reached, the answer is deny.
//
// Minimal MCP over stdio (newline-delimited JSON-RPC), no dependencies.
import { createInterface } from 'node:readline'

const BRIDGE_URL = process.env.BRIDGE_URL ?? ''
const BRIDGE_CHAT = process.env.BRIDGE_CHAT ?? ''

const TOOL = {
  name: 'approve',
  description: 'Asks the user on Discord to allow or deny a tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function deny(message: string) {
  return { behavior: 'deny', message }
}

async function ask(args: any): Promise<unknown> {
  if (!BRIDGE_URL) return deny('The Discord bridge is not available, so nobody could be asked.')
  try {
    const res = await fetch(`${BRIDGE_URL}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat: BRIDGE_CHAT, tool_name: args?.tool_name, input: args?.input ?? {} }),
    })
    if (!res.ok) return deny(`The Discord bridge refused the request (${res.status}).`)
    const { id } = (await res.json()) as { id: string }
    // The bridge answers each wait within about 25 s ("pending" until the user
    // decides or the request times out), so no single request stays open long.
    for (;;) {
      const w = await fetch(`${BRIDGE_URL}/wait?id=${encodeURIComponent(id)}`)
      if (!w.ok) return deny('The Discord bridge lost this request.')
      const body = (await w.json()) as { pending?: boolean; decision?: unknown }
      if (!body.pending) return body.decision ?? deny('The Discord bridge gave no decision.')
    }
  } catch (e) {
    return deny(`The Discord bridge could not be reached (${e instanceof Error ? e.message : e}).`)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg?.id === undefined) return // a notification: nothing to answer
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bridge', version: '0.1.0' },
      })
      break
    case 'ping':
      reply({})
      break
    case 'tools/list':
      reply({ tools: [TOOL] })
      break
    case 'tools/call':
      if (msg.params?.name !== TOOL.name) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } })
        break
      }
      void ask(msg.params?.arguments).then(decision => {
        // An allow must carry the input it approves.
        const d = decision as any
        if (d?.behavior === 'allow' && d.updatedInput === undefined) {
          d.updatedInput = msg.params?.arguments?.input ?? {}
        }
        reply({ content: [{ type: 'text', text: JSON.stringify(d) }] })
      })
      break
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
rl.on('close', () => process.exit(0))
