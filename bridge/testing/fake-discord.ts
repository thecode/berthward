// A stand-in for Discord, for tests: the gateway (WebSocket) and the parts of
// the REST API the bridge uses. It keeps every message the bot sends, lets a
// test play the user (write a message, click a button, use a slash command)
// and wait for the bot's reaction.
//
// It implements just enough of the protocol for discord.js to connect and
// work; it does not check permissions, rate limits or payload validity.

export const BOT_ID = '900000000000000001'
export const GUILD_ID = '900000000000000002'
export const CHANNEL_ID = '900000000000000003'
export const OTHER_CHANNEL_ID = '900000000000000004'
export const OWNER_ID = '900000000000000005'
export const STRANGER_ID = '900000000000000006'

export interface FakeMessage {
  id: string
  channel_id: string
  author_id: string
  content: string
  components: any[]
  ephemeral: boolean
  deleted: boolean
  reactions: string[]
  /** Files on the message: the ones a user attached, or the ones the bot uploaded. */
  files: Array<{ name: string; size: number; text: string }>
}

const now = () => new Date().toISOString()
const user = (id: string, name: string, bot = false) => ({
  id,
  username: name,
  global_name: bot ? null : `${name} display`,
  discriminator: '0',
  avatar: null,
  bot,
})
const BOT = user(BOT_ID, 'testbot', true)
const USERS: Record<string, any> = {
  [BOT_ID]: BOT,
  [OWNER_ID]: user(OWNER_ID, 'owner'),
  [STRANGER_ID]: user(STRANGER_ID, 'stranger'),
}
const textChannel = (id: string, name: string) => ({
  id,
  type: 0,
  name,
  guild_id: GUILD_ID,
  position: 0,
  permission_overwrites: [],
  nsfw: false,
  rate_limit_per_user: 0,
})

export async function startFakeDiscord() {
  let next = 910000000000000000n
  const newId = () => String(next++)
  const messages: FakeMessage[] = []
  const interactionReplies: Array<{ interaction: string; type: number; data: any }> = []
  let commands: any[] = []
  let socket: { send(data: string): void } | null = null
  let seq = 0
  const waiters: Array<() => void> = []
  const changed = () => waiters.splice(0).forEach(w => w())

  const dispatch = (t: string, d: unknown) => socket?.send(JSON.stringify({ op: 0, t, s: ++seq, d }))

  const wire = (m: FakeMessage) => ({
    id: m.id,
    channel_id: m.channel_id,
    ...(m.channel_id === CHANNEL_ID || m.channel_id === OTHER_CHANNEL_ID ? { guild_id: GUILD_ID } : {}),
    author: USERS[m.author_id],
    content: m.content,
    timestamp: now(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    embeds: [],
    pinned: false,
    type: 0,
    flags: m.ephemeral ? 64 : 0,
    components: m.components,
    attachments: m.files.map((f, i) => ({
      id: `${m.id}${i}`,
      filename: f.name,
      size: f.size,
      content_type: 'text/plain; charset=utf-8',
      url: `http://127.0.0.1:${server.port}/files/${m.id}/${i}`,
      proxy_url: `http://127.0.0.1:${server.port}/files/${m.id}/${i}`,
    })),
  })

  const addMessage = (channel: string, author: string, body: any): FakeMessage => {
    const m: FakeMessage = {
      id: newId(),
      channel_id: channel,
      author_id: author,
      content: body?.content ?? '',
      components: body?.components ?? [],
      ephemeral: ((body?.flags ?? 0) & 64) === 64,
      deleted: false,
      reactions: [],
      files: body?.files ?? [],
    }
    messages.push(m)
    changed()
    return m
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/gateway' || url.pathname === '/gateway/') {
        return srv.upgrade(req) ? (undefined as any) : new Response('upgrade failed', { status: 400 })
      }
      let m0: RegExpExecArray | null
      // Where an attached file is downloaded from.
      if ((m0 = /^\/files\/(\d+)\/(\d+)$/.exec(url.pathname))) {
        const file = messages.find(x => x.id === m0![1])?.files[Number(m0[2])]
        if (file?.name === 'broken.txt') return new Response('gone', { status: 404 })
        return file ? new Response(file.text) : new Response('no such file', { status: 404 })
      }
      const path = url.pathname.replace(/^\/api\/v\d+/, '')
      let body: any = null
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
          // A message with uploaded files: the fields are payload_json and files[n].
          const form = await req.formData()
          body = JSON.parse(String(form.get('payload_json') ?? '{}'))
          body.files = []
          for (const [key, value] of form.entries()) {
            if (!key.startsWith('files[') || typeof value === 'string') continue
            const text = await value.text()
            body.files.push({ name: value.name, size: text.length, text })
          }
        } else {
          body = await req.json().catch(() => null)
        }
      }
      const json = (d: unknown, status = 200) => Response.json(d, { status })
      const none = () => new Response(null, { status: 204 })
      let m: RegExpExecArray | null

      if (path === '/gateway/bot') {
        return json({
          url: `ws://127.0.0.1:${server.port}/gateway`,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 },
        })
      }
      if ((m = /^\/applications\/\d+\/commands$/.exec(path)) && req.method === 'PUT') {
        commands = (body as any[]).map(c => ({ ...c, id: newId(), application_id: BOT_ID, version: '1', type: 1 }))
        changed()
        return json(commands)
      }
      if ((m = /^\/channels\/(\d+)\/messages$/.exec(path)) && req.method === 'POST') {
        return json(wire(addMessage(m[1], BOT_ID, body)))
      }
      if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
        const msg = messages.find(x => x.id === m![2])
        if (!msg) return json({ message: 'Unknown Message', code: 10008 }, 404)
        if (req.method === 'PATCH') {
          if (body?.content !== undefined) msg.content = body.content
          if (body?.components !== undefined) msg.components = body.components
          changed()
          return json(wire(msg))
        }
        if (req.method === 'DELETE') {
          msg.deleted = true
          changed()
          return none()
        }
        return json(wire(msg))
      }
      if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/.exec(path)) && req.method === 'PUT') {
        messages.find(x => x.id === m![2])?.reactions.push(decodeURIComponent(m[3]))
        changed()
        return none()
      }
      if (/^\/channels\/\d+\/typing$/.exec(path)) return none()
      if ((m = /^\/channels\/(\d+)$/.exec(path))) {
        if (m[1] === CHANNEL_ID) return json(textChannel(CHANNEL_ID, 'server'))
        if (m[1] === OTHER_CHANNEL_ID) return json(textChannel(OTHER_CHANNEL_ID, 'elsewhere'))
        return json({ id: m[1], type: 1, recipients: [USERS[OWNER_ID]] })
      }
      if (path === '/users/@me/channels' && req.method === 'POST') {
        return json({ id: '9' + String(body?.recipient_id).slice(1), type: 1, recipients: [USERS[body?.recipient_id]] })
      }
      if ((m = /^\/users\/(\d+)$/.exec(path))) return json(USERS[m[1]] ?? user(m[1], 'someone'))
      if ((m = /^\/interactions\/(\d+)\/[^/]+\/callback$/.exec(path)) && req.method === 'POST') {
        const reply = { interaction: m[1], type: body?.type, data: body?.data }
        interactionReplies.push(reply)
        const source = pendingInteractions.get(m[1])
        // 4 = reply with a message, 7 = update the message the button is on.
        if (reply.type === 4 && source) addMessage(source.channel, BOT_ID, reply.data)
        if (reply.type === 7 && source?.message) {
          const msg = messages.find(x => x.id === source.message)
          if (msg) {
            if (reply.data?.content !== undefined) msg.content = reply.data.content
            if (reply.data?.components !== undefined) msg.components = reply.data.components
          }
        }
        changed()
        return none()
      }
      if ((m = /^\/webhooks\/\d+\/([^/]+)$/.exec(path)) && req.method === 'POST') {
        const source = [...pendingInteractions.values()].find(p => p.token === m![1])
        return json(wire(addMessage(source?.channel ?? CHANNEL_ID, BOT_ID, body)))
      }
      return json({ message: `fake discord: no route for ${req.method} ${path}`, code: 0 }, 404)
    },
    websocket: {
      open(ws) {
        socket = ws
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }))
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw))
        if (msg.op === 1) ws.send(JSON.stringify({ op: 11 }))
        if (msg.op === 2) {
          identified = msg.d
          dispatch('READY', {
            v: 10,
            user: BOT,
            guilds: [{ id: GUILD_ID, unavailable: true }],
            session_id: 'fake-session',
            resume_gateway_url: `ws://127.0.0.1:${server.port}/gateway`,
            application: { id: BOT_ID, flags: 0 },
          })
          dispatch('GUILD_CREATE', {
            id: GUILD_ID,
            name: 'test server',
            owner_id: OWNER_ID,
            unavailable: false,
            member_count: 3,
            joined_at: now(),
            large: false,
            features: [],
            channels: [textChannel(CHANNEL_ID, 'server'), textChannel(OTHER_CHANNEL_ID, 'elsewhere')],
            threads: [],
            members: [],
            presences: [],
            voice_states: [],
            emojis: [],
            stickers: [],
            stage_instances: [],
            guild_scheduled_events: [],
            roles: [
              { id: GUILD_ID, name: '@everyone', permissions: '0', position: 0, color: 0, hoist: false, managed: false, mentionable: false },
            ],
          })
          changed()
        }
      },
      close() {
        socket = null
      },
    },
  })

  let identified: any = null
  const pendingInteractions = new Map<string, { token: string; channel: string; message?: string }>()

  const member = (id: string, nick: string | null = null) => ({
    user: USERS[id],
    nick,
    roles: [],
    joined_at: now(),
    deaf: false,
    mute: false,
    flags: 0,
    permissions: '8',
  })

  function interaction(type: number, who: string, channel: string, data: any, message?: FakeMessage) {
    const id = newId()
    const token = `tok${id}`
    pendingInteractions.set(id, { token, channel, message: message?.id })
    dispatch('INTERACTION_CREATE', {
      id,
      application_id: BOT_ID,
      type,
      token,
      version: 1,
      guild_id: GUILD_ID,
      channel_id: channel,
      channel: textChannel(channel, 'server'),
      member: member(who, who === OWNER_ID ? 'Owner Nick' : null),
      app_permissions: '8',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: { '0': GUILD_ID },
      context: 0,
      attachment_size_limit: 10_000_000,
      data,
      ...(message ? { message: wire(message) } : {}),
    })
    return id
  }

  return {
    apiUrl: `http://127.0.0.1:${server.port}/api`,
    messages,
    interactionReplies,
    get commands() {
      return commands
    },
    get identified() {
      return identified
    },

    /** The user writes a message. */
    say(content: string, opts: { from?: string; channel?: string; files?: Array<{ name: string; text: string; size?: number }> } = {}) {
      const files = (opts.files ?? []).map(f => ({ name: f.name, text: f.text, size: f.size ?? f.text.length }))
      const m = addMessage(opts.channel ?? CHANNEL_ID, opts.from ?? OWNER_ID, { content, files })
      dispatch('MESSAGE_CREATE', { ...wire(m), member: member(m.author_id) })
      return m
    },

    /** The user clicks the button with this label on a message. */
    click(message: FakeMessage, label: string, opts: { from?: string } = {}) {
      const button = message.components.flatMap((row: any) => row.components ?? []).find((b: any) => b.label === label)
      if (!button) throw new Error(`no button "${label}" on message: ${message.content.slice(0, 80)}`)
      return interaction(3, opts.from ?? OWNER_ID, message.channel_id, { custom_id: button.custom_id, component_type: 2 }, message)
    },

    /** The user runs a slash command. */
    slash(name: string, options: Record<string, string> = {}, opts: { from?: string; channel?: string } = {}) {
      const cmd = commands.find(c => c.name === name)
      return interaction(2, opts.from ?? OWNER_ID, opts.channel ?? CHANNEL_ID, {
        id: cmd?.id ?? newId(),
        name,
        type: 1,
        options: Object.entries(options).map(([n, value]) => ({ name: n, type: 3, value })),
      })
    },

    /** The user types into a slash command option; resolves with the suggestions. */
    async autocomplete(name: string, option: string, typed: string): Promise<string[]> {
      const id = interaction(4, OWNER_ID, CHANNEL_ID, {
        id: commands.find(c => c.name === name)?.id ?? newId(),
        name,
        type: 1,
        options: [{ name: option, type: 3, value: typed, focused: true }],
      })
      const reply = await this.until(() => interactionReplies.find(r => r.interaction === id))
      return (reply.data?.choices ?? []).map((c: any) => c.value)
    },

    /** Waits until `check` returns something truthy, re-checking whenever anything happens. */
    async until<T>(check: () => T | undefined | null | false, ms = 8000): Promise<T> {
      const deadline = Date.now() + ms
      for (;;) {
        const value = check()
        if (value) return value
        const left = deadline - Date.now()
        if (left <= 0) {
          throw new Error(
            `timed out waiting. Messages so far:\n${messages.map(m => `  [${m.author_id === BOT_ID ? 'bot' : 'user'}] ${m.content.slice(0, 120)}`).join('\n')}`,
          )
        }
        await Promise.race([new Promise<void>(r => waiters.push(r)), Bun.sleep(Math.min(left, 100))])
      }
    },

    /** The newest message from the bot whose text contains `text`. */
    botSaid(text: string, after?: FakeMessage): FakeMessage | undefined {
      const from = after ? messages.indexOf(after) + 1 : 0
      return messages.slice(from).findLast(m => m.author_id === BOT_ID && !m.deleted && m.content.includes(text))
    },

    stop() {
      server.stop(true)
    },
  }
}

export type FakeDiscord = Awaited<ReturnType<typeof startFakeDiscord>>
