// Integration tests: the real bridge process, talking to a stand-in for
// Discord (testing/fake-discord.ts) and running a stand-in for the `claude`
// command (testing/fake-claude.ts). The tests play the user.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOT_ID,
  CHANNEL_ID,
  OTHER_CHANNEL_ID,
  OWNER_ID,
  STRANGER_ID,
  startFakeDiscord,
  type FakeDiscord,
  type FakeMessage,
} from './testing/fake-discord'

const here = import.meta.dir
// The real script: next to the sources in the repository, on PATH in the image.
const discordSend = existsSync(join(here, '..', 'discord-send')) ? join(here, '..', 'discord-send') : 'discord-send'
let dir: string
let discord: FakeDiscord
let bridge: ReturnType<typeof Bun.spawn>
let bridgeLog = ''
let claudeLog: string

/** What the stand-in for claude was called with, one entry per call. */
const claudeCalls = () =>
  existsSync(claudeLog)
    ? readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []

/** Writes a message and waits for the bot's next message containing `expect`. */
async function ask(text: string, expectText: string): Promise<FakeMessage> {
  const mine = discord.say(text)
  return discord.until(() => discord.botSaid(expectText, mine))
}

/** Starts the bridge process and waits until it has connected. */
async function startBridge(): Promise<void> {
  bridgeLog = ''
  bridge = Bun.spawn(['bun', join(here, 'bridge.ts')], {
    env: bridgeEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const part of stream) bridgeLog += decoder.decode(part)
  }
  void collect(bridge.stdout as ReadableStream<Uint8Array>)
  void collect(bridge.stderr as ReadableStream<Uint8Array>)
  await discord.until(() => bridgeLog.includes('connected as'), 15000).catch(() => {
    throw new Error(`the bridge did not connect. Its output:\n${bridgeLog}`)
  })
}
let bridgeEnv: Record<string, string>
let webPort: number

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
  for (const d of ['bin', 'home', 'state', 'work', 'tasks']) mkdirSync(join(dir, d))
  // `claude` on PATH is the stand-in.
  writeFileSync(join(dir, 'bin', 'claude'), `#!/bin/sh\nexec bun "${join(here, 'testing', 'fake-claude.ts')}" "$@"\n`)
  chmodSync(join(dir, 'bin', 'claude'), 0o755)
  claudeLog = join(dir, 'claude.log')

  discord = await startFakeDiscord()
  // A free port for the web terminal.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  webPort = probe.port
  probe.stop(true)
  bridgeEnv = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: join(dir, 'home'),
      TZ: 'UTC',
      DISCORD_BOT_TOKEN: 'fake-token-for-tests',
      DISCORD_ALLOWED_USERS: OWNER_ID,
      DISCORD_CHANNELS: CHANNEL_ID,
      WEB_PASSWORD: 'must-not-leak',
      WEB_TERMINAL: 'true',
      WEB_PORT: String(webPort),
      BRIDGE_DISCORD_API: discord.apiUrl,
      BRIDGE_STATE_DIR: join(dir, 'state'),
      BRIDGE_WORKDIR: join(dir, 'work'),
      BRIDGE_TASKS_DIR: join(dir, 'tasks'),
      BRIDGE_APPROVAL_TIMEOUT: '2',
      BRIDGE_RUN_TIMEOUT: '0.1', // six seconds
      // About 2 KB each way, so the size limits can be tested with small files.
      BRIDGE_ATTACH_MAX_MB: '0.002',
      BRIDGE_SEND_MAX_MB: '0.002',
      FAKE_DISCORD_SEND: discordSend,
      FAKE_CLAUDE_LOG: claudeLog,
      FAKE_LOST_SESSION: join(dir, 'lost-session'),
  }
  await startBridge()
}, 20000)

afterAll(async () => {
  bridge?.kill()
  await bridge?.exited
  discord?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('start', () => {
  test('connects with the message-content intent and registers the slash commands', async () => {
    expect(discord.identified.token).toBe('fake-token-for-tests')
    // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
    expect(discord.identified.intents & (1 << 15)).toBe(1 << 15)
    const names = (await discord.until(() => (discord.commands.length ? discord.commands : null))).map((c: any) => c.name)
    expect(names).toEqual(['new', 'stop', 'status', 'tasks', 'run', 'login', 'code', 'restart-session', 'help'])
    const run = discord.commands.find((c: any) => c.name === 'run')
    expect(run.options[0]).toMatchObject({ name: 'name', required: true, autocomplete: true })
  })

  test('says hello once, with the command list', async () => {
    const hello = await discord.until(() => discord.botSaid('Berthward is connected'))
    expect(hello.channel_id).toBe(CHANNEL_ID)
    expect(hello.content).toContain('/tasks')
    expect(hello.content).toContain('/run <name>')
    // The greeting and /help say that the terminal has a different conversation.
    expect(hello.content).toContain('The terminal, web terminal and Claude app share a different one')
    // The explanation comes first, the command list after it.
    expect(hello.content.indexOf('Write here to talk to Claude')).toBeLessThan(hello.content.indexOf('**Commands**'))
    expect(hello.content.indexOf('share a different one')).toBeLessThan(hello.content.indexOf('**Commands**'))
    // Remembered, so a restart does not greet again (written just after the message is sent).
    const file = join(dir, 'state', 'state.json')
    await discord.until(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).welcomed === true)
  })
})

describe('who is heard', () => {
  test('a stranger and another channel are ignored', async () => {
    const before = claudeCalls().length
    discord.say('hello from a stranger', { from: STRANGER_ID })
    discord.say('hello from elsewhere', { channel: OTHER_CHANNEL_ID })
    await ask('hello one', 'fake claude heard: hello one')
    // Only the last message reached Claude.
    expect(claudeCalls().length).toBe(before + 1)
    expect(discord.messages.some(m => m.author_id === BOT_ID && m.channel_id === OTHER_CHANNEL_ID)).toBe(false)
  })

  test('a stranger cannot use slash commands or buttons', async () => {
    const id = discord.slash('status', {}, { from: STRANGER_ID })
    const reply = await discord.until(() => discord.interactionReplies.find(r => r.interaction === id))
    expect(reply.data.content).toContain('not allowed')
    expect(reply.data.flags & 64).toBe(64) // only they see it
  })
})

describe('chat', () => {
  test('Claude gets the message without the bridge secrets, and the conversation continues', async () => {
    const first = await ask('hello two', 'fake claude heard: hello two')
    expect(first.content).toContain('resumed conversation') // "hello one" started it
    const calls = claudeCalls().filter(c => c.prompt?.startsWith('hello'))
    expect(calls.at(-1).resume).toBe(calls[0].sessionId)
    for (const c of calls) {
      expect(c.sawBotToken).toBe(false)
      expect(c.sawWebPassword).toBe(false)
      expect(c.cwd).toBe(join(dir, 'work'))
      expect(c.args).toContain('--permission-prompt-tool')
    }
  })

  test('/new starts a fresh conversation', async () => {
    discord.slash('new')
    await discord.until(() => discord.botSaid('fresh conversation'))
    const reply = await ask('hello three', 'fake claude heard: hello three')
    expect(reply.content).toContain('new conversation')
  })

  test('a lost conversation is replaced by a new one without bothering the user', async () => {
    writeFileSync(join(dir, 'lost-session'), '')
    const reply = await ask('hello four', 'fake claude heard: hello four')
    rmSync(join(dir, 'lost-session'))
    expect(reply.content).toContain('new conversation')
    expect(discord.botSaid('stopped with an error')).toBeUndefined()
  })

  test('not logged in: a plain message that points to /login', async () => {
    const reply = await ask('pretend you are not logged in', 'not logged in on this server')
    expect(reply.content).toContain('/login')
  })

  test('an unknown ! or / command lists the commands instead of going to Claude', async () => {
    const before = claudeCalls().length
    const reply = await ask('!bogus', '`!bogus` is not one of my commands')
    expect(reply.content).toContain('/status')
    // Claude Code would read "/compact" as one of its own commands.
    const slash = await ask('/compact', '`/compact` is not one of my commands')
    expect(slash.content).toContain('start the message with another word')
    expect(claudeCalls().length).toBe(before)
  })

  test('a slash command typed as a plain message still works', async () => {
    const before = claudeCalls().length
    await ask('/status', 'Idle; 0 queued')
    await ask('/run nope', 'There is no task `nope`')
    expect(claudeCalls().length).toBe(before)
  })

  test('a path at the start of a message is not mistaken for a command', async () => {
    await ask('/mnt/cache is that the pool?', 'fake claude heard: /mnt/cache is that the pool?')
  })

  test('/status and !status both answer', async () => {
    discord.slash('status')
    expect((await discord.until(() => discord.botSaid('Idle; 0 queued'))).content).toContain('conversation: ongoing')
    await ask('!status', 'Idle; 0 queued')
  })
})

describe('permission requests', () => {
  test('allow: only the owner can answer, and the answer reaches Claude', async () => {
    const mine = discord.say('this needs permission')
    const request = await discord.until(() => discord.botSaid('Permission needed: Bash', mine))
    expect(request.content).toContain('touch /tmp/needs-permission')

    // A stranger's click changes nothing.
    const strangerClick = discord.click(request, 'Allow', { from: STRANGER_ID })
    const refusal = await discord.until(() => discord.interactionReplies.find(r => r.interaction === strangerClick))
    expect(refusal.data.content).toContain('not allowed')
    expect(request.components.length).toBe(1)

    discord.click(request, 'Allow')
    await discord.until(() => discord.botSaid('the permission was: allow', mine))
    expect(request.content).toContain('Allowed by Owner Nick') // the server nickname, not the username
    expect(request.components).toEqual([])
  })

  test('deny', async () => {
    const mine = discord.say('this needs permission too')
    const request = await discord.until(() => discord.botSaid('Permission needed: Bash', mine))
    discord.click(request, 'Deny')
    await discord.until(() => discord.botSaid('the permission was: deny', mine))
    expect(request.content).toContain('Denied by Owner Nick')
  })

  test('no answer in time counts as a deny', async () => {
    const mine = discord.say('this needs permission, nobody answers')
    const request = await discord.until(() => discord.botSaid('Permission needed: Bash', mine))
    await discord.until(() => discord.botSaid('the permission was: deny', mine), 10000)
    expect(request.content).toContain('No answer in time')
    expect(request.components).toEqual([])
  }, 15000)
})

describe('a job in progress', () => {
  test('later messages are queued with a clock, and /stop ends the job and drops them', async () => {
    const slow = discord.say('do something slow')
    await discord.until(() => discord.botSaid('starting something slow', slow))
    const queued = discord.say('hello while busy')
    await discord.until(() => queued.reactions.length > 0)
    expect(queued.reactions[0]).toBe('🕒')

    discord.slash('status')
    await discord.until(() => discord.botSaid('Working on a message; 1 queued', slow))

    discord.slash('stop')
    await discord.until(() => discord.botSaid('Stopping the running job', slow))
    await discord.until(() => discord.botSaid('🛑 Stopped.', slow))
    // The queued message was dropped, not run afterwards.
    await ask('hello after stop', 'fake claude heard: hello after stop')
    expect(discord.botSaid('fake claude heard: hello while busy')).toBeUndefined()
  }, 20000)
})

describe('a job that never ends', () => {
  test('is stopped at the time limit, the user is told, and the chat works again', async () => {
    const slow = discord.say('do something slow again')
    await discord.until(() => discord.botSaid('starting something slow', slow))
    const note = await discord.until(() => discord.botSaid('⏱️ Stopped: the job ran for 0.1 minutes', slow), 15000)
    expect(note.content).toContain('raise the job time limit')
    await ask('hello after the limit', 'fake claude heard: hello after the limit')
  }, 25000)
})

describe('tasks', () => {
  const writeTask = (name: string, json: object, file: string, body: string) => {
    mkdirSync(join(dir, 'tasks', name), { recursive: true })
    writeFileSync(join(dir, 'tasks', name, 'task.json'), JSON.stringify(json))
    writeFileSync(join(dir, 'tasks', name, file), body)
  }

  test('a new task must be approved before it runs, then reports its alert', async () => {
    writeTask('disk-check', { kind: 'script', schedule: '0 3 * * *' }, 'check.sh', 'echo "disk 2 is failing"\nexit 1\n')
    expect(await discord.autocomplete('run', 'name', 'disk')).toEqual(['disk-check'])

    const first = discord.slash('run', { name: 'disk-check' })
    const request = await discord.until(() => discord.botSaid('needs your approval before it runs'))
    expect(request.content).toContain('disk 2 is failing') // the script is shown
    await discord.until(() => discord.interactionReplies.find(r => r.interaction === first))
    expect(discord.botSaid('🚨 **disk-check**')).toBeUndefined()

    discord.click(request, 'Approve')
    await discord.until(() => request.content.includes('approved by Owner Nick'))

    discord.slash('run', { name: 'disk-check' })
    const alert = await discord.until(() => discord.botSaid('🚨 **disk-check**'))
    expect(alert.content).toContain('disk 2 is failing')

    discord.slash('tasks')
    const list = await discord.until(() => discord.botSaid('**Tasks**'))
    expect(list.content).toContain('`disk-check` (script, `0 3 * * *`)')
    expect(list.content).toContain('alert')
  })

  test('changing an approved task asks again', async () => {
    writeTask('disk-check', { kind: 'script', schedule: '0 3 * * *' }, 'check.sh', 'exit 0\n')
    const marker = discord.say('!run disk-check')
    const request = await discord.until(() => discord.botSaid('was changed and needs your approval', marker))
    discord.click(request, 'Reject')
    await discord.until(() => request.content.includes('rejected by Owner Nick'))
  })

  test('a prompt task is answered by Claude; "OK" stays quiet', async () => {
    writeTask('digest', { kind: 'prompt', schedule: '0 8 * * *' }, 'prompt.md', 'how is the server')
    writeTask('quiet-one', { kind: 'prompt', schedule: '0 8 * * *' }, 'prompt.md', 'stay quiet')
    for (const name of ['digest', 'quiet-one']) {
      const marker = discord.say(`!run ${name}`)
      const request = await discord.until(() => discord.botSaid(`Task \`${name}\`** is new`, marker))
      discord.click(request, 'Approve')
      await discord.until(() => request.content.includes('approved by'))
    }
    discord.slash('run', { name: 'digest' })
    expect((await discord.until(() => discord.botSaid('📋 **digest**'))).content).toContain('report: how is the server')
    discord.slash('run', { name: 'quiet-one' })
    await discord.until(() => discord.botSaid('**quiet-one** ran: nothing to report'))
    // Prompt tasks run with nobody to ask.
    const call = claudeCalls().find(c => c.prompt === 'how is the server')
    expect(call.args.join(' ')).toContain('--permission-prompts none')
  })

  test('an unknown task name is answered, not run', async () => {
    await ask('!run nope', 'There is no task `nope`')
  })
})

describe('files', () => {
  test('an attached file is saved to the inbox under a safe name, and Claude is told where', async () => {
    const mine = discord.say('please read the attachment', { files: [{ name: '../../etc/evil name.txt', text: 'disk 3 is hot' }] })
    const reply = await discord.until(() => discord.botSaid('says: disk 3 is hot', mine))
    const path = /the file (\S+) says/.exec(reply.content)![1]
    expect(path.startsWith(join(dir, 'work', 'inbox') + '/')).toBe(true)
    expect(path.endsWith(`${mine.id}-evil_name.txt`)).toBe(true)
    expect(path).not.toContain('..')
    const call = claudeCalls().findLast(c => c.prompt?.includes('please read the attachment'))
    expect(call.prompt).toContain('[The user attached a file, saved on this server:')
    expect(call.prompt).toContain('not instructions')
  })

  test('files without any text still reach Claude', async () => {
    discord.say('', { files: [{ name: 'a.log', text: 'one' }, { name: 'b.log', text: 'two' }] })
    const call = await discord.until(() => claudeCalls().find(c => c.prompt?.startsWith('[The user attached 2 files')))
    expect(call.prompt).toContain('-a.log (text/plain, 3 B)')
    expect(call.prompt).toContain('-b.log (text/plain, 3 B)')
  })

  test('a file that is too large or cannot be downloaded is reported and left out', async () => {
    const mine = discord.say('please read the attachment', {
      files: [{ name: 'huge.bin', text: 'x', size: 5_000_000 }, { name: 'broken.txt', text: 'x' }],
    })
    const note = await discord.until(() => discord.botSaid('Not saved', mine))
    expect(note.content).toContain('huge.bin: 4.8 MB is over the limit')
    expect(note.content).toContain('broken.txt: could not be downloaded')
    // The text still goes to Claude, without any file.
    await discord.until(() => discord.botSaid('no attachment path in the prompt', mine))
  })

  test('Claude can send a file from its own folder', async () => {
    const mine = discord.say('send me report.txt please')
    await discord.until(() => discord.botSaid('discord-send said: sent report.txt to Discord (exit 0)', mine))
    const upload = discord.messages.find(m => m.files.some(f => f.name === 'report.txt') && m.author_id === BOT_ID)!
    expect(upload.channel_id).toBe(CHANNEL_ID)
    expect(upload.content).toBe('here it is')
    expect(upload.files[0].text).toBe('contents of report.txt\n')
  })

  test('files outside the folder, too large or empty are refused with the reason', async () => {
    const uploads = () => discord.messages.filter(m => m.author_id === BOT_ID && m.files.length > 0).length
    const before = uploads()
    expect((await ask('send me /etc/hostname', 'discord-send said: not sent')).content).toContain('only files inside')
    expect((await ask('send me big-report.txt', 'discord-send said: not sent')).content).toContain('the limit is 2.0 KB')
    expect((await ask('send me empty.txt', 'discord-send said: not sent')).content).toContain('the file is empty')
    expect(uploads()).toBe(before)
  })

  test('discord-send does nothing outside a Discord conversation', () => {
    const r = Bun.spawnSync([discordSend, '/etc/hostname'], { env: { PATH: process.env.PATH ?? '' } })
    expect(r.exitCode).toBe(2)
    expect(r.stderr.toString()).toContain('only works while answering a message from Discord')
  })
})

describe('web terminal sign-in, approved on Discord', () => {
  const web = () => `http://127.0.0.1:${webPort}`
  const signIn = (password: string) =>
    fetch(`${web()}/login`, {
      method: 'POST',
      headers: { origin: web(), 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
  const status = async (id: string) => {
    const res = await fetch(`${web()}/login/status?id=${id}`)
    return { ...((await res.json()) as { status: string }), cookie: res.headers.get('set-cookie') ?? '' }
  }
  /** The answer, once there is one: the bridge edits its Discord message a moment before the page is told. */
  const answered = async (id: string) => {
    for (;;) {
      const s = await status(id)
      if (s.status !== 'pending') return s
      await Bun.sleep(20)
    }
  }

  test('a wrong password never produces a request on Discord', async () => {
    expect(bridgeLog).toContain('web: terminal on port')
    expect((await signIn('wrong')).status).toBe(403)
    expect(discord.botSaid('Web terminal sign-in')).toBeUndefined()
  })

  test('allow: the request shows the code, only the owner can answer, and the browser is signed in', async () => {
    const { id, code } = (await (await signIn('must-not-leak')).json()) as { id: string; code: string }
    const request = await discord.until(() => discord.botSaid('Web terminal sign-in'))
    expect(request.content).toContain(`Code shown in the browser: **${code}**`)
    expect(request.content).toContain('From: `127.0.0.1`')
    expect(request.content).toContain('Page opened at: `127.0.0.1:')
    expect((await status(id)).status).toBe('pending')

    const strangerClick = discord.click(request, 'Allow', { from: STRANGER_ID })
    await discord.until(() => discord.interactionReplies.find(r => r.interaction === strangerClick))
    expect((await status(id)).status).toBe('pending')

    discord.click(request, 'Allow')
    await discord.until(() => request.content.includes('Allowed by Owner Nick'))
    const done = await answered(id)
    expect(done.status).toBe('allowed')
    expect(done.cookie).toContain('HttpOnly')
    const page = await (await fetch(web() + '/', { headers: { cookie: done.cookie.split(';')[0] } })).text()
    expect(page).toContain('id="t"') // the terminal page
  })

  test('deny: the browser is not signed in', async () => {
    const mark = discord.messages.at(-1)
    const { id } = (await (await signIn('must-not-leak')).json()) as { id: string }
    const request = await discord.until(() => discord.botSaid('Web terminal sign-in', mark))
    discord.click(request, 'Deny')
    await discord.until(() => request.content.includes('Denied by Owner Nick'))
    const done = await answered(id)
    expect(done.status).toBe('denied')
    expect(done.cookie).toBe('')
  })
})

describe('login from Discord', () => {
  test('/login posts the link; /code keeps the code private and finishes the login', async () => {
    discord.slash('login')
    const link = await discord.until(() => discord.botSaid('Open the sign-in page'))
    expect(link.content).toContain('[Open the sign-in page](<https://signin.example.test/oauth?state=abc>)')

    const id = discord.slash('code', { code: 'good-code' })
    const reply = await discord.until(() => discord.interactionReplies.find(r => r.interaction === id))
    expect(reply.data.content).toContain('Code received')
    expect(reply.data.flags & 64).toBe(64) // only the user sees it
    await discord.until(() => discord.botSaid('✅ Claude is logged in'))
    expect(existsSync(join(dir, 'home', '.claude', '.credentials.json'))).toBe(true)
    expect(discord.messages.some(m => m.content.includes('good-code') && !m.ephemeral && m.author_id === BOT_ID)).toBe(false)
  })

  test('!code removes the message that carried the code, and a wrong code is reported', async () => {
    discord.say('!login')
    const link = await discord.until(() => discord.botSaid('Open the sign-in page', discord.messages.at(-2)))
    expect(link).toBeDefined()
    const code = discord.say('!code wrong-code')
    await discord.until(() => code.deleted)
    await discord.until(() => discord.botSaid('The login did not complete', code))
  })

  test('a cancelled login ends with one line and no failure report', async () => {
    const start = discord.say('!login')
    await discord.until(() => discord.botSaid('Open the sign-in page', start))
    const cancel = discord.say('!login cancel')
    await discord.until(() => discord.botSaid('Login cancelled.', cancel))
    await Bun.sleep(400) // time for the login process to end
    expect(discord.botSaid('The login did not complete', cancel)).toBeUndefined()
    const again = discord.say('!login cancel')
    await discord.until(() => discord.botSaid('No login is waiting', again))
  })

  test('/code with no login waiting says so', async () => {
    const id = discord.slash('code', { code: 'whatever' })
    const reply = await discord.until(() => discord.interactionReplies.find(r => r.interaction === id))
    expect(reply.data.content).toContain('No login is waiting')
  })
})

describe('after a bridge update', () => {
  test('an ongoing conversation is given the new instructions once; the hello is not repeated', async () => {
    await ask('hello before the update', 'fake claude heard: hello before the update')
    const hellos = () => discord.messages.filter(m => m.content.includes('Berthward is connected')).length
    const before = hellos()

    // Restart the bridge as if it had been updated: the stored conversation
    // carries the fingerprint of older instructions.
    bridge.kill()
    await bridge.exited
    const file = join(dir, 'state', 'state.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    expect(state.prompts[CHANNEL_ID]).toMatch(/^[0-9a-f]{16}$/)
    state.prompts[CHANNEL_ID] = 'older-instructions'
    writeFileSync(file, JSON.stringify(state))
    await startBridge()

    await ask('hello after the update', '(resumed conversation)')
    const first = claudeCalls().findLast(c => c.prompt?.includes('hello after the update'))
    expect(first.prompt).toContain('Note from the Discord bridge, not from the user')
    expect(first.prompt).toContain('discord-send <path>')
    expect(first.prompt.endsWith('hello after the update')).toBe(true)

    await ask('hello once more', 'fake claude heard: hello once more')
    expect(claudeCalls().findLast(c => c.prompt?.includes('hello once more')).prompt).toBe('hello once more')
    expect(hellos()).toBe(before)
  }, 30000)
})
