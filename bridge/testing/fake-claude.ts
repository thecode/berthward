#!/usr/bin/env bun
// A stand-in for the `claude` command, for tests. It is put on PATH as
// "claude" and behaves just enough like Claude Code for the bridge:
//
//   claude auth login          prints a sign-in link, waits for a code on stdin
//   claude -p ... (stream-json) a chat turn; what it does depends on the prompt
//   claude -p ... (json)        a prompt task; answers "OK" or a short report
//
// Every call is appended to $FAKE_CLAUDE_LOG as one JSON line, including
// whether secrets were visible in its environment.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const stdinText = async () => (await new Response(Bun.stdin.stream()).text()).trim()
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
const record = (extra: object) => {
  if (!process.env.FAKE_CLAUDE_LOG) return
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({
      args,
      sawBotToken: 'DISCORD_BOT_TOKEN' in process.env,
      sawWebPassword: 'WEB_PASSWORD' in process.env,
      cwd: process.cwd(),
      bridgeChat: process.env.BRIDGE_CHAT ?? null,
      bridgeUrl: process.env.BRIDGE_URL ?? null,
      ...extra,
    }) + '\n',
  )
}

if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write('Opening browser to sign in…\n')
  process.stdout.write("If the browser didn't open, visit: https://signin.example.test/oauth?state=abc\n\n")
  process.stdout.write('Paste code here if prompted > ')
  const code = (await new Promise<string>(resolve => {
    let buf = ''
    process.stdin.on('data', d => {
      buf += d
      if (buf.includes('\n')) resolve(buf)
    })
    process.stdin.on('end', () => resolve(buf))
  })).trim()
  record({ login: true, code })
  if (code === 'good-code') {
    const dir = join(process.env.HOME ?? '/tmp', '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.credentials.json'), '{}')
    process.stdout.write('\nLogin successful.\n')
    process.exit(0)
  }
  process.stdout.write('\nInvalid code.\n')
  process.exit(1)
}

const prompt = await stdinText()
const resume = opt('--resume')
const sessionId = resume ?? opt('--session-id') ?? 'no-session'
record({ prompt, resume: resume ?? null, sessionId })
// What the user wrote, without a note the bridge may have put in front of it.
const said = prompt.replace(/^\[Note from the Discord bridge[\s\S]*?\]\n\n/, '')

if (opt('--output-format') === 'json') {
  // A scheduled prompt task.
  out({ type: 'result', subtype: 'success', is_error: false, result: said.includes('quiet') ? 'OK' : `report: ${said}` })
  process.exit(0)
}

if (said.includes('not logged in')) {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: sessionId })
  process.exit(1)
}
if (resume && process.env.FAKE_LOST_SESSION && existsSync(process.env.FAKE_LOST_SESSION)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`)
  process.exit(1)
}

out({ type: 'system', subtype: 'init', session_id: sessionId })
const say = (text: string) => out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text }] } })

if (said.includes('slow')) {
  say('starting something slow')
  process.on('SIGINT', () => process.exit(130))
  await Bun.sleep(60_000)
}

if (said.includes('send me')) {
  // What Claude does to send a file: write it, then run discord-send.
  const where = /send me (\S+)/.exec(said)?.[1] ?? 'report.txt'
  const path = where.startsWith('/') ? where : join(process.cwd(), where)
  if (!where.startsWith('/')) writeFileSync(path, where.includes('empty') ? '' : where.includes('big') ? 'x'.repeat(5000) : `contents of ${where}\n`)
  const sent = Bun.spawnSync([process.env.FAKE_DISCORD_SEND ?? 'discord-send', path, 'here it is'], { env: process.env })
  say(`discord-send said: ${(sent.stdout.toString() + sent.stderr.toString()).trim()} (exit ${sent.exitCode})`)
} else if (said.includes('read the attachment')) {
  const path = /^- (\/\S+) \(/m.exec(said)?.[1]
  say(path ? `the file ${path} says: ${readFileSync(path, 'utf8').trim()}` : 'no attachment path in the prompt')
} else if (said.includes('needs permission')) {
  // What Claude Code does through the permission tool, done directly.
  const cfg = JSON.parse(opt('--mcp-config') ?? '{}').mcpServers?.bridge?.env ?? {}
  const res = await fetch(`${cfg.BRIDGE_URL}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': cfg.BRIDGE_TOKEN ?? '' },
    body: JSON.stringify({ chat: cfg.BRIDGE_CHAT, tool_name: 'Bash', input: { command: said.includes('long command') ? `echo ${'x'.repeat(3000)} && touch /tmp/end-marker` : 'touch /tmp/needs-permission' } }),
  })
  const { id } = (await res.json()) as { id: string }
  let decision: any
  for (;;) {
    const w = (await (await fetch(`${cfg.BRIDGE_URL}/wait?id=${id}`, { headers: { 'x-bridge-token': cfg.BRIDGE_TOKEN ?? '' } })).json()) as any
    if (!w.pending) {
      decision = w.decision
      break
    }
  }
  say(`the permission was: ${decision.behavior}`)
} else {
  say(`fake claude heard: ${said} (${resume ? 'resumed' : 'new'} conversation)`)
  // The answer is out, the run is not over yet: as with the real Claude,
  // which takes a moment to finish after its last words.
  if (said.includes('linger')) await Bun.sleep(700)
}
// FAKE_LINGER_MS makes every run take that long to end after its answer, the
// way a slow machine does. Running the tests with it set finds tests (and
// code) that assume a run is over the moment its answer appears.
if (Number(process.env.FAKE_LINGER_MS) > 0) await Bun.sleep(Number(process.env.FAKE_LINGER_MS))
out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId })
