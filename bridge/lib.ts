// Pure helpers for the Discord bridge. No Discord or process access here, so
// they can be tested with `bun test`.

export interface Access {
  users: Set<string>
  channels: Set<string>
  requireMention: boolean
}

const SNOWFLAKE = /^[0-9]{15,22}$/

/** Comma- or space-separated Discord IDs. Throws on anything that is not one. */
export function parseIds(raw: string | undefined, what: string): string[] {
  const out: string[] = []
  for (const id of (raw ?? '').split(/[\s,]+/)) {
    if (id === '') continue
    if (!SNOWFLAKE.test(id)) {
      throw new Error(`${what}: '${id}' is not a Discord ID (digits only; Developer Mode → Copy ID)`)
    }
    out.push(id)
  }
  return out
}

export function parseAccess(env: Record<string, string | undefined>): Access {
  const users = parseIds(env.DISCORD_ALLOWED_USERS, 'DISCORD_ALLOWED_USERS')
  if (users.length === 0) {
    throw new Error('DISCORD_ALLOWED_USERS is empty: refusing to start without an allowlist')
  }
  const channels = parseIds(env.DISCORD_CHANNELS, 'DISCORD_CHANNELS')
  const requireMention = /^(true|1|yes)$/i.test(env.DISCORD_REQUIRE_MENTION ?? '')
  return { users: new Set(users), channels: new Set(channels), requireMention }
}

export interface Inbound {
  authorId: string
  authorIsBot: boolean
  isDM: boolean
  /** Channel ID; for a thread, the parent channel's ID. */
  channelId: string
  mentionsBot: boolean
}

/** Whether a message is for Claude at all. Everything else is ignored silently. */
export function accepts(access: Access, m: Inbound): boolean {
  if (m.authorIsBot) return false
  if (!access.users.has(m.authorId)) return false
  if (m.isDM) return true
  if (!access.channels.has(m.channelId)) return false
  return !access.requireMention || m.mentionsBot
}

/**
 * Split text into pieces Discord accepts (2000 characters at most). Prefers to
 * cut at a blank line, then a line break, then a space. A code fence that is
 * open at a cut is closed and reopened so both pieces still render.
 */
export function chunk(text: string, limit = 1900): string[] {
  const out: string[] = []
  let rest = text.trim()
  let reopen = ''
  while (rest.length > 0) {
    let piece = reopen + rest
    if (piece.length <= limit) {
      out.push(piece)
      break
    }
    const window = piece.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    piece = piece.slice(0, cut)
    rest = (reopen + rest).slice(cut).replace(/^\n+/, '')
    const fences = piece.match(/^```/gm)?.length ?? 0
    if (fences % 2 === 1) {
      const lang = piece.match(/^```([^\n`]*)$/gm)?.pop()?.slice(3) ?? ''
      piece += '\n```'
      reopen = '```' + lang + '\n'
    } else {
      reopen = ''
    }
    out.push(piece)
  }
  return out
}

/** How much of a request fits in the message; a longer one is also attached in full. */
export const REQUEST_SHOWN = 1500

/** The complete text of what Claude asks permission for. */
export function requestBody(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash' && typeof i.command === 'string') return i.command
  if (typeof i.file_path === 'string' && Object.keys(i).length === 1) return i.file_path
  return JSON.stringify(input, null, 2) ?? ''
}

/** What to show the user when Claude asks for permission. */
export function describeRequest(toolName: string, input: unknown, max = REQUEST_SHOWN): string {
  let body = requestBody(toolName, input)
  // Allow approves the whole request, so the user must be able to read all of it.
  if (body.length > max) body = body.slice(0, max) + '\n… (cut: the complete text is in the attached file)'
  // A ``` inside the body would end the code block early.
  body = body.replace(/```/g, '`\u200b``')
  return `🔐 **Permission needed: ${toolName}**\n\`\`\`\n${body}\n\`\`\``
}

export interface StreamEvent {
  sessionId?: string
  /** Text blocks of an assistant message, in order. */
  texts: string[]
  /** Set on the final message of a run. */
  result?: { ok: boolean; text: string }
}

/** One line of `claude -p --output-format stream-json`. Unknown lines yield nothing. */
export function parseStreamLine(line: string): StreamEvent | null {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  if (msg === null || typeof msg !== 'object') return null
  const ev: StreamEvent = { texts: [] }
  if (typeof msg.session_id === 'string') ev.sessionId = msg.session_id
  if (msg.type === 'assistant' && !msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        ev.texts.push(block.text)
      }
    }
  } else if (msg.type === 'result') {
    ev.result = {
      ok: msg.is_error !== true && (msg.subtype === undefined || msg.subtype === 'success'),
      text: typeof msg.result === 'string' ? msg.result : '',
    }
  }
  return ev
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * A file name that is safe to create: no folders, no leading dot, only plain
 * characters, not too long. The extension is kept so tools still recognise
 * the file.
 */
export function safeFileName(name: string | null | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  let clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '')
  if (clean.length > 80) {
    const dot = clean.lastIndexOf('.')
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : ''
    clean = clean.slice(0, 80 - ext.length) + ext
  }
  return clean === '' ? 'file' : clean
}

/** "512 B", "3.4 KB", "12.0 MB" */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Megabytes from a setting, as bytes; the fallback when it is empty or not a positive number. */
export function megabytes(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim())
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallback) * 1024 * 1024)
}

/**
 * Minutes from a setting, as milliseconds. "0" means no limit and gives 0;
 * an empty or unreadable value gives the fallback.
 */
export function minutes(raw: string | undefined, fallback: number): number {
  const text = (raw ?? '').trim()
  const n = text === '' ? fallback : Number(text)
  return Math.round((Number.isFinite(n) && n >= 0 ? n : fallback) * 60_000)
}

// ── Web sign-in details ──────────────────────────────────────────────────────

/** "Chrome 131 on Windows" from a User-Agent header; the raw text when it is not recognised. */
export function describeAgent(ua: string): string {
  const os = /Windows NT/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  // Order matters: Edge and Opera also say "Chrome", and Chrome also says "Safari".
  const browsers: Array<[string, RegExp]> = [
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari/],
  ]
  for (const [name, re] of browsers) {
    const m = re.exec(ua)
    if (m) return `${name} ${m[1]}${os ? ` on ${os}` : ''}`
  }
  // Whoever can reach the port chooses this text and it is shown on Discord:
  // keep only what cannot form a link, a mention or formatting.
  const raw = ua.replace(/[^A-Za-z0-9 .;/(),+-]+/g, ' ').replace(/ +/g, ' ').trim().slice(0, 100)
  return raw === '' ? 'unknown browser' : raw
}

export const SESSION_HOURS_DEFAULT = 12
export const SESSION_HOURS_MAX = 168

/**
 * WEB_SESSION_HOURS: how long a browser stays signed in to the web terminal.
 * 0 = never stay signed in (only while the page is open). Anything else is
 * hours, capped at a week. Empty or unreadable values give the default.
 */
export function parseSessionHours(raw: string | undefined): number {
  const text = (raw ?? '').trim()
  if (text === '') return SESSION_HOURS_DEFAULT
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return SESSION_HOURS_DEFAULT
  return Math.min(n, SESSION_HOURS_MAX)
}

/** Where an address is, as far as the address itself tells. */
export function describeAddress(ip: string): string {
  const a = ip.replace(/^::ffff:/i, '')
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])]
    if (x === 127) return 'this container'
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return 'local network'
    if (x === 169 && y === 254) return 'local link'
    if (x === 100 && y >= 64 && y <= 127) return 'VPN or carrier-shared range'
    return 'public internet'
  }
  const l = a.toLowerCase()
  if (l === '::1') return 'this container'
  if (/^f[cd]/.test(l)) return 'local network'
  if (/^fe[89ab]/.test(l)) return 'local link'
  return a.includes(':') ? 'public internet' : 'unknown'
}

// ── Scheduled tasks ──────────────────────────────────────────────────────────

const CRON_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}
const CRON_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
]

export interface Cron {
  fields: Array<Set<number>>
  domAny: boolean
  dowAny: boolean
}

/** Five-field cron: numbers, `*`, lists, ranges and steps. Throws on anything else. */
export function parseCron(expr: string): Cron {
  const text = CRON_ALIASES[expr.trim()] ?? expr.trim()
  const parts = text.split(/\s+/)
  if (parts.length !== 5) throw new Error(`schedule '${expr}': expected 5 fields (minute hour day month weekday)`)
  const fields = parts.map((part, i) => {
    const [lo, hi] = CRON_RANGES[i]
    const set = new Set<number>()
    for (const item of part.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item)
      if (!m) throw new Error(`schedule '${expr}': cannot read '${item}'`)
      const from = m[1] === '*' ? lo : Number(m[2])
      const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from
      const step = m[4] !== undefined ? Number(m[4]) : 1
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`schedule '${expr}': '${item}' is out of range`)
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v)
    }
    return set
  })
  return { fields, domAny: parts[2] === '*', dowAny: parts[4] === '*' }
}

/** Whether a schedule fires in the minute of `d` (local time). */
export function cronMatches(cron: Cron, d: Date): boolean {
  const [min, hour, dom, month, dow] = cron.fields
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !month.has(d.getMonth() + 1)) return false
  const domOk = dom.has(d.getDate())
  const dowOk = dow.has(d.getDay())
  // Classic cron: when both day fields are restricted, either one matching is enough.
  if (!cron.domAny && !cron.dowAny) return domOk || dowOk
  return domOk && dowOk
}

export const TASK_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

export interface TaskConfig {
  schedule: string
  cron: Cron
  kind: 'script' | 'prompt'
  enabled: boolean
  /** Seconds before a run is killed. */
  timeout: number
  /** Hours between reminders while a script task keeps failing with the same output. */
  remind: number
}

/** Reads a task.json. Throws with a message meant for the user. */
export function parseTaskConfig(json: string): TaskConfig {
  let raw: any
  try {
    raw = JSON.parse(json)
  } catch (e) {
    throw new Error(`task.json is not valid JSON (${e instanceof Error ? e.message : e})`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('task.json must be an object')
  if (raw.kind !== 'script' && raw.kind !== 'prompt') throw new Error('task.json: "kind" must be "script" or "prompt"')
  if (typeof raw.schedule !== 'string') throw new Error('task.json: "schedule" must be a cron string, e.g. "0 * * * *"')
  const num = (v: unknown, fallback: number, min: number, max: number, name: string) => {
    if (v === undefined) return fallback
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`task.json: "${name}" must be a number from ${min} to ${max}`)
    }
    return v
  }
  return {
    schedule: raw.schedule,
    cron: parseCron(raw.schedule),
    kind: raw.kind,
    enabled: raw.enabled !== false,
    timeout: num(raw.timeout, raw.kind === 'script' ? 300 : 900, 1, 3600, 'timeout'),
    remind: num(raw.remind, 24, 0, 720, 'remind'),
  }
}

export interface TaskRunState {
  status: 'ok' | 'failing'
  /** Output of the last failing run that was posted. */
  lastOutput?: string
  lastNotified?: number
}

export type Notice = 'alert' | 'recovered' | 'report' | null

/**
 * What to post after a run.
 * - failed run: an alert when it starts failing, when the output changes, or
 *   after `remindHours` of the same failure (0 = never remind)
 * - successful run after a failure: "recovered"
 * - successful run with output: a report, every time
 * - successful run without output: nothing
 */
export function decideNotice(
  prev: TaskRunState | undefined,
  run: { ok: boolean; output: string },
  now: number,
  remindHours: number,
): Notice {
  if (!run.ok) {
    if (prev?.status !== 'failing') return 'alert'
    if (prev.lastOutput !== run.output) return 'alert'
    if (remindHours > 0 && now - (prev.lastNotified ?? 0) >= remindHours * 3600_000) return 'alert'
    return null
  }
  if (prev?.status === 'failing') return 'recovered'
  return run.output.trim() === '' ? null : 'report'
}

/** A prompt task answers exactly OK (any case, optional full stop) when there is nothing to report. */
export function isQuietAnswer(text: string): boolean {
  return /^\s*ok\.?\s*$/i.test(text)
}

/** The most `/run` passes on to a task's script. */
export const RUN_ARGS_MAX = 10
export const RUN_ARG_LENGTH_MAX = 100

/**
 * What follows `/run`: the task's name, then words handed to its script as
 * arguments. Words are split at spaces and nothing else: there is no quoting,
 * and the words never pass through a shell. Throws with a message meant for
 * the user.
 */
export function parseRunRequest(text: string): { name: string; args: string[] } {
  const [name = '', ...args] = text.trim().split(/\s+/).filter(Boolean)
  if (args.length > RUN_ARGS_MAX) throw new Error(`At most ${RUN_ARGS_MAX} arguments can be passed to a task.`)
  if (args.some(a => a.length > RUN_ARG_LENGTH_MAX)) throw new Error(`An argument can be at most ${RUN_ARG_LENGTH_MAX} characters.`)
  // Printable ASCII only: the words are shown back on Discord and land in a script.
  if (args.some(a => !/^[\x21-\x7e]+$/.test(a))) throw new Error('Arguments can only hold plain letters, digits and punctuation.')
  return { name: name.toLowerCase(), args }
}

/**
 * Suggestions for the task-name field of `/run` while the user types. Words
 * after the name are arguments typed in the same field: they stay on every
 * suggestion, so picking one (or sending without picking) keeps them.
 */
export function runSuggestions(names: string[], typed: string): string[] {
  const [first = '', ...rest] = typed.trim().split(/\s+/).filter(Boolean)
  const name = first.toLowerCase()
  // Once arguments follow, the name is finished: an exact match is the only suggestion.
  const matching = rest.length > 0 && names.includes(name) ? [name] : names.filter(n => n.includes(name))
  return matching
    .map(n => [n, ...rest].join(' '))
    .filter(s => s.length <= 100) // Discord's limit for a suggestion
    .slice(0, 25)
}
