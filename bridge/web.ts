// Web terminal: the interactive Claude session (the tmux session) in a browser.
//
// Sign-in has no account of its own. A browser asks to sign in (after the
// optional password), the bridge shows the request on Discord with the
// browser's address and a short code that the page shows too, and only an
// allowed user's click on Allow signs that browser in. The session cookie is
// kept in memory, so a container restart signs everyone out.
//
// Without the Discord bridge there is a password-only mode (see web-only.ts):
// one factor, so it needs a long password, locks an address out after a few
// wrong tries and logs every sign-in.
//
// The page is plain HTTP, like Unraid's own web UI by default. Put it behind a
// TLS reverse proxy if it is reachable from anywhere but a trusted LAN.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { reverse } from 'node:dns/promises'
import { dirname, join } from 'node:path'
import { describeAddress, describeAgent } from './lib'

export interface SignInInfo {
  /** The code the page shows, to compare with the request. */
  code: string
  ip: string
  /** Reverse-DNS name of the address, when the network's DNS knows one. */
  hostname: string
  /** "local network", "public internet", … */
  where: string
  /** "Chrome 131 on Windows" */
  browser: string
  /** The address the browser used to reach this page. */
  via: string
  /**
   * The page was opened under a public-looking host name and no list of host
   * names is set: worth a second look before allowing.
   */
  viaUnfamiliar: boolean
  /** "City, Country (network)" for a public address, when the lookup is on. */
  location: string
}

/**
 * Approximate location of a public address from an outside service
 * (ipapi.co). Only called when the owner turned the lookup on, and never for
 * private addresses. Empty when the service does not answer in time.
 */
async function lookupLocation(ip: string): Promise<string> {
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return ''
    const d = (await res.json()) as Record<string, unknown>
    const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} .,'()&-]/gu, '').trim().slice(0, 60) : '')
    const place = [clean(d.city), clean(d.country_name)].filter(Boolean).join(', ')
    const org = clean(d.org)
    return place ? `${place}${org ? ` (${org})` : ''}` : ''
  } catch {
    return ''
  }
}

/** Reverse DNS with a short limit: the sign-in must not wait on a slow resolver. */
async function reverseName(ip: string): Promise<string> {
  try {
    const names = await Promise.race([
      reverse(ip.replace(/^::ffff:/i, '')),
      new Promise<string[]>(resolve => setTimeout(() => resolve([]), 1500)),
    ])
    return (names[0] ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
  } catch {
    return ''
  }
}

/** How a sign-in request ended. "expired" = nobody answered in time. */
export type SignInAnswer = 'allowed' | 'denied' | 'expired'

/** The name in a Host header: lower case, without port, brackets or final dot. */
export function hostName(header: string): string {
  const h = header.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1).split(']')[0]
  return h.replace(/:\d+$/, '').replace(/\.$/, '')
}

/** An IP address (v4 or v6) or localhost: never a name somebody else controls. */
function isAddress(name: string): boolean {
  return name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')
}

// Suffixes that are not sold as public domains, so no outside party can make a
// name under them point at this server.
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa', '.localdomain', '.localhost']

/**
 * A name that cannot be used for DNS rebinding: an address, a bare name
 * ("nas"), or a name under a private-use suffix. Rebinding needs a public
 * domain that the attacker controls and points at this server's address.
 */
export function localName(name: string): boolean {
  if (name === '') return false
  if (isAddress(name) || !name.includes('.')) return true
  return LOCAL_SUFFIXES.some(suffix => name.endsWith(suffix))
}

export interface WebHost {
  port: number
  /** Empty = no password step. */
  password: string
  /** tmux session to attach to. */
  session: string
  /** Hours a browser stays signed in; 0 = only while the page is open. */
  ttlHours: number
  log(msg: string): void
  /**
   * Asks on Discord. Resolves "allowed" only when an allowed user clicked Allow.
   * Absent = password-only mode: the password alone signs a browser in.
   */
  approve?: (info: SignInInfo) => Promise<SignInAnswer>
  /**
   * Host names the page may be opened under, besides plain addresses. Empty =
   * any name is served, and a public-looking one is flagged in the sign-in
   * request. With a list, a request under any other name is refused, which
   * closes DNS rebinding.
   */
  allowedHosts?: string[]
  /**
   * A reverse proxy is in front: take the browser's address, host and scheme
   * from its X-Forwarded-* headers. Only safe when nothing else can reach
   * this port, since any client could send those headers.
   */
  trustProxy?: boolean
  /** Look up the location of public addresses for the sign-in request. */
  geoLookup?: boolean
}

/** Shortest password accepted when the password is the only factor. */
export const PASSWORD_ONLY_MIN = 12
const LOCKOUT_TRIES = 5
const LOCKOUT_MS = 15 * 60_000

const COOKIE = 'berthward'
// Sign-in requests posted to Discord: a few per address, so that one address
// cannot use up everyone's, and a cap on all of them together.
const LOGIN_WINDOW_MS = 10 * 60_000
const LOGIN_MAX_PER_ADDRESS = 4
const LOGIN_MAX_PER_WINDOW = 12
/** With "never stay signed in": how long a sign-in survives with no terminal open. */
const NO_STAY_GRACE_MS = 2 * 60_000
/** With "never stay signed in": the longest one sitting can last. */
const NO_STAY_MAX_HOURS = 24
const MODULES = join(dirname(Bun.main), 'node_modules')

const ASSETS: Record<string, { file?: string; body?: string; type: string }> = {
  '/assets/xterm.js': { file: join(MODULES, '@xterm/xterm/lib/xterm.js'), type: 'text/javascript' },
  '/assets/xterm.css': { file: join(MODULES, '@xterm/xterm/css/xterm.css'), type: 'text/css' },
  '/assets/addon-fit.js': { file: join(MODULES, '@xterm/addon-fit/lib/addon-fit.js'), type: 'text/javascript' },
}

const STYLE = `
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; background: #14161a; color: #e6e6e6;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 22rem; margin: 12vh auto 0; padding: 0 1rem; }
  h1 { font-size: 1.2rem; font-weight: 600; margin: 0 0 1rem; }
  input, button { font: inherit; width: 100%; box-sizing: border-box; padding: .6rem .7rem; border-radius: 6px;
    border: 1px solid #3a3f47; background: #1d2026; color: inherit; }
  button { margin-top: .8rem; background: #2f6feb; border-color: #2f6feb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .code { font: 600 1.8rem ui-monospace, Menlo, Consolas, monospace; letter-spacing: .2em; margin: .6rem 0; }
  .muted { color: #9aa3ad; font-size: .9rem; }
  .err { color: #ff7b72; min-height: 1.5em; margin-top: .6rem; }
  #bar { display: flex; gap: 1rem; align-items: center; padding: .25rem .7rem; background: #1d2026;
    font-size: .85rem; color: #9aa3ad; }
  #bar button { width: auto; margin: 0 0 0 auto; padding: .15rem .6rem; background: transparent; border-color: #3a3f47; }
  #t { position: absolute; top: 2rem; bottom: 0; left: 0; right: 0; padding: 4px; }
`

function page(title: string, body: string, scripts: string[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/xterm.css">
<style>${STYLE}</style></head>
<body>${body}
${scripts.map(s => `<script src="${s}"></script>`).join('\n')}
</body></html>`
}

const LOGIN_JS = `
const form = document.getElementById('f'), err = document.getElementById('err'), wait = document.getElementById('wait');
form.addEventListener('submit', async e => {
  e.preventDefault(); err.textContent = '';
  const btn = form.querySelector('button'); btn.disabled = true;
  const pw = document.getElementById('pw');
  try {
    const r = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw ? pw.value : '' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error || 'Sign-in is not possible right now.'; btn.disabled = false; return; }
    if (j.status === 'allowed') { location.replace('/'); return; }
    form.hidden = true; wait.hidden = false;
    document.getElementById('code').textContent = j.code;
    for (;;) {
      await new Promise(r => setTimeout(r, 1500));
      const s = await (await fetch('/login/status?id=' + encodeURIComponent(j.id))).json().catch(() => ({ status: 'gone' }));
      if (s.status === 'allowed') { location.replace('/'); return; }
      if (s.status !== 'pending') {
        wait.hidden = true; form.hidden = false; btn.disabled = false;
        err.textContent = s.status === 'denied' ? 'The request was denied on Discord.' : 'The request was not answered in time.';
        return;
      }
    }
  } catch { err.textContent = 'The server did not answer.'; btn.disabled = false; }
});
`

const TERM_JS = `
const term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 14,
  fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace', theme: { background: '#14161a' } });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit); term.open(document.getElementById('t')); fit.fit(); term.focus();
const state = document.getElementById('state');
let ws = null;
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
term.onData(d => send({ t: 'i', d }));
term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
addEventListener('resize', () => fit.fit());
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { state.textContent = 'connected'; send({ t: 'r', c: term.cols, r: term.rows }); };
  ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  ws.onclose = e => {
    if (e.code === 4401) { location.replace('/'); return; }
    state.textContent = e.code === 4404 ? 'no interactive session is running on the server' : 'disconnected, retrying…';
    setTimeout(connect, e.code === 4404 ? 15000 : 3000);
  };
}
connect();
document.getElementById('out').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' }); location.replace('/');
});
`

function sha(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

interface PendingLogin {
  code: string
  ip: string
  status: 'pending' | 'allowed' | 'denied' | 'expired'
  created: number
}

export function startWeb(host: WebHost) {
  const passwordOnly = !host.approve
  if (passwordOnly && host.password.length < PASSWORD_ONLY_MIN) {
    throw new Error(`without Discord approval the web terminal needs a password of at least ${PASSWORD_ONLY_MIN} characters`)
  }
  /** address → wrong-password count and when the lock ends */
  const failures = new Map<string, { count: number; until: number }>()
  interface Session {
    expires: number
    /** Open terminals of this sign-in. */
    sockets: Set<{ close(code?: number, reason?: string): void }>
    /** When the last terminal closed (or the sign-in happened). */
    idleSince: number
  }
  const sessions = new Map<string, Session>() // cookie value → session
  const logins = new Map<string, PendingLogin>()
  let recent: Array<{ at: number; ip: string }> = []
  const allowedHosts = new Set((host.allowedHosts ?? []).map(hostName).filter(Boolean))
  /** Refused names already written to the log, so a scanner cannot flood it. */
  const refusedNames = new Set<string>()

  const headers = (type: string, extra: Record<string, string> = {}) => ({
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    ...extra,
  })
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: headers('application/json', extra) })

  function cookieOf(req: Request): string | undefined {
    for (const part of (req.headers.get('cookie') ?? '').split(';')) {
      const [k, v] = part.trim().split('=')
      if (k === COOKIE && v) return v
    }
  }
  /** The valid session of a cookie value, if any. Expired ones are removed. */
  function sessionOf(c: string | undefined): Session | undefined {
    if (!c) return undefined
    const s = sessions.get(c)
    if (!s) return undefined
    const now = Date.now()
    // "Never stay signed in": valid while a terminal is open, plus a short
    // grace period so a reload or a network blip does not ask again.
    const idleOut = host.ttlHours === 0 && s.sockets.size === 0 && now > s.idleSince + NO_STAY_GRACE_MS
    if (now > s.expires || idleOut) {
      sessions.delete(c)
      for (const ws of s.sockets) ws.close(4401, 'sign in')
      return undefined
    }
    return s
  }
  function signedIn(req: Request): boolean {
    return sessionOf(cookieOf(req)) !== undefined
  }
  // An open terminal must not outlive its sign-in.
  setInterval(() => {
    for (const c of [...sessions.keys()]) sessionOf(c)
  }, 30_000).unref()
  /** The host name the browser used; from the proxy's header when one is trusted. */
  function hostOf(req: Request): string {
    const forwarded = host.trustProxy ? req.headers.get('x-forwarded-host')?.split(',')[0].trim() : ''
    return forwarded || (req.headers.get('host') ?? '')
  }
  /**
   * The browser's address. Behind a trusted proxy it is the last entry of
   * X-Forwarded-For, the one that proxy added itself; earlier entries are
   * whatever the client claimed.
   */
  function addressOf(req: Request, socket: string): string {
    if (!host.trustProxy) return socket
    const last = (req.headers.get('x-forwarded-for') ?? '').split(',').pop()?.trim() ?? ''
    return /^[0-9a-fA-F.:]{3,45}$/.test(last) ? last : socket
  }
  function secureOf(req: Request): boolean {
    return host.trustProxy === true && req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
  }
  /** A browser only sends our own pages' requests with a matching Origin. */
  function sameOrigin(req: Request): boolean {
    const origin = req.headers.get('origin')
    if (!origin) return false
    try {
      return new URL(origin).host === hostOf(req)
    } catch {
      return false
    }
  }
  /** Creates the signed-in session and returns the cookie that carries it. */
  function issueSession(req: Request, ip: string): string {
    const value = randomBytes(32).toString('base64url')
    // 0 hours: a cookie that the browser drops when it closes, and a
    // server-side session that ends soon after the last terminal closes.
    const stay = host.ttlHours > 0
    const ttl = Math.round((stay ? host.ttlHours : NO_STAY_MAX_HOURS) * 3600)
    sessions.set(value, { expires: Date.now() + ttl * 1000, sockets: new Set(), idleSince: Date.now() })
    host.log(`web: ${ip} signed in${stay ? ` for ${host.ttlHours} h` : ' (until the page is closed)'}`)
    // Lax, not Strict: the page is usually opened from a link on another
    // site (Unraid's WebUI button, a bookmark page), and Strict would not
    // send the cookie on that first request, asking for a new sign-in each
    // time. Cross-site POSTs and the WebSocket are covered by the Origin check.
    return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/${stay ? `; Max-Age=${ttl}` : ''}${secureOf(req) ? '; Secure' : ''}`
  }

  const server = Bun.serve<{ proc?: ReturnType<typeof Bun.spawn> }, never>({
    hostname: '0.0.0.0',
    port: host.port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const ip = addressOf(req, srv.requestIP(req)?.address ?? 'unknown')
      const name = hostName(hostOf(req))
      if (allowedHosts.size > 0 && !allowedHosts.has(name) && !isAddress(name)) {
        const shown = name.replace(/[^a-z0-9.-]/g, '').slice(0, 80)
        if (refusedNames.size < 20 && !refusedNames.has(shown)) {
          refusedNames.add(shown)
          host.log(`web: refused a request for host name "${shown}" from ${ip}: it is not in Web Terminal Host Names`)
        }
        return new Response(
          'This page was opened under a host name that is not on its list. Add the name to "Web Terminal Host Names" in the container template, or open the page by its address.',
          { status: 403, headers: headers('text/plain') },
        )
      }

      const asset = ASSETS[url.pathname]
      if (asset?.file) return new Response(Bun.file(asset.file), { headers: headers(asset.type) })
      if (url.pathname === '/assets/login.js') return new Response(LOGIN_JS, { headers: headers('text/javascript') })
      if (url.pathname === '/assets/term.js') {
        if (!signedIn(req)) return new Response('', { status: 401 })
        return new Response(TERM_JS, { headers: headers('text/javascript') })
      }

      if (req.method === 'GET' && url.pathname === '/') {
        if (signedIn(req)) {
          return new Response(
            page(
              'Claude session',
              `<div id="bar"><span>Claude session</span><span id="state">connecting…</span><button id="out">Sign out</button></div><div id="t"></div>`,
              ['/assets/xterm.js', '/assets/addon-fit.js', '/assets/term.js'],
            ),
            { headers: headers('text/html') },
          )
        }
        return new Response(
          page(
            'Sign in',
            `<div class="card"><h1>Claude session</h1>
<form id="f">${host.password ? '<input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus>' : ''}
<button>${passwordOnly ? 'Sign in' : 'Sign in with Discord approval'}</button></form>
${
  passwordOnly
    ? ''
    : `<div id="wait" hidden><p>Approve this sign-in on Discord. The request shows this code:</p>
<div class="code" id="code"></div><p class="muted">Waiting for your answer…</p></div>`
}
<div class="err" id="err"></div></div>`,
            ['/assets/login.js'],
          ),
          { headers: headers('text/html') },
        )
      }

      if (req.method === 'POST' && url.pathname === '/login') {
        if (!sameOrigin(req)) return json({ error: 'Bad request.' }, 400)
        const now = Date.now()
        const body = (await req.json().catch(() => null)) as any
        if (host.password) {
          const lock = failures.get(ip)
          if (lock && lock.count >= LOCKOUT_TRIES && now < lock.until) {
            return json({ error: 'Too many wrong passwords from this address. Try again later.' }, 429)
          }
          const given = typeof body?.password === 'string' ? body.password : ''
          if (!timingSafeEqual(sha(given), sha(host.password))) {
            await Bun.sleep(1000)
            const count = (lock && now < lock.until ? lock.count : 0) + 1
            failures.set(ip, { count, until: now + LOCKOUT_MS })
            host.log(`web: wrong password from ${ip} (${count} of ${LOCKOUT_TRIES})`)
            return json({ error: 'Wrong password.' }, 403)
          }
          failures.delete(ip)
        }
        if (passwordOnly) {
          return json({ status: 'allowed' }, 200, { 'set-cookie': issueSession(req, ip) })
        }
        // A limit on requests posted to Discord, whoever asks. It comes after
        // the password check: wrong passwords are limited per address above,
        // and must not be able to keep everyone else from signing in.
        recent = recent.filter(r => now - r.at < LOGIN_WINDOW_MS)
        if (recent.filter(r => r.ip === ip).length >= LOGIN_MAX_PER_ADDRESS || recent.length >= LOGIN_MAX_PER_WINDOW) {
          return json({ error: 'Too many sign-in attempts. Try again in a few minutes.' }, 429)
        }
        recent.push({ at: now, ip })
        for (const l of logins.values()) {
          if (l.ip === ip && l.status === 'pending') return json({ error: 'A sign-in from this address is already waiting on Discord.' }, 429)
        }
        const id = randomBytes(24).toString('base64url')
        // No look-alike characters, so the code is easy to compare by eye.
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        const code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('')
        const login: PendingLogin = { code, ip, status: 'pending', created: now }
        logins.set(id, login)
        const info: SignInInfo = {
          code,
          ip,
          hostname: await reverseName(ip),
          where: describeAddress(ip),
          browser: describeAgent(req.headers.get('user-agent') ?? ''),
          via: hostOf(req).replace(/[^A-Za-z0-9.:\[\]-]/g, '').slice(0, 80),
          location: '',
          viaUnfamiliar: allowedHosts.size === 0 && !localName(name),
        }
        if (host.geoLookup && info.where === 'public internet') info.location = await lookupLocation(ip)
        host.log(`web: sign-in request from ${ip}${info.hostname ? ` (${info.hostname})` : ''}, ${info.browser}`)
        void host.approve!(info)
          .then(answer => {
            login.status = answer
          })
          .catch(() => {
            login.status = 'denied'
          })
        setTimeout(() => logins.delete(id), LOGIN_WINDOW_MS).unref()
        return json({ id, code })
      }

      if (req.method === 'GET' && url.pathname === '/login/status') {
        const id = url.searchParams.get('id') ?? ''
        const login = logins.get(id)
        if (!login) return json({ status: 'gone' })
        if (login.status !== 'allowed') return json({ status: login.status })
        // Only the address that asked can collect the session, and only once.
        if (login.ip !== ip) return json({ status: 'gone' })
        logins.delete(id)
        return json({ status: 'allowed' }, 200, { 'set-cookie': issueSession(req, ip) })
      }

      if (req.method === 'POST' && url.pathname === '/logout') {
        const c = cookieOf(req)
        const s = c ? sessions.get(c) : undefined
        if (c && s) {
          sessions.delete(c)
          for (const ws of s.sockets) ws.close(4401, 'sign in')
        }
        return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` })
      }

      if (url.pathname === '/ws') {
        if (!sameOrigin(req)) return new Response('bad origin', { status: 403 })
        // Upgrade first so the page gets a close code it can act on.
        if (srv.upgrade(req, { data: { session: sessionOf(cookieOf(req)) } as any })) return undefined as any
        return new Response('upgrade failed', { status: 400 })
      }

      return new Response('not found', { status: 404, headers: headers('text/plain') })
    },
    websocket: {
      idleTimeout: 300,
      open(ws) {
        const session = (ws.data as any).session as Session | undefined
        if (!session) {
          ws.close(4401, 'sign in')
          return
        }
        session.sockets.add(ws)
        const target = `=${host.session}`
        if (Bun.spawnSync(['tmux', 'has-session', '-t', target]).exitCode !== 0) {
          ws.close(4404, 'no session')
          return
        }
        const proc = Bun.spawn(['tmux', 'attach', '-t', target], {
          env: { ...process.env, TERM: 'xterm-256color' },
          terminal: {
            cols: 100,
            rows: 30,
            data(_t: unknown, data: Uint8Array) {
              ws.send(data)
            },
          },
        } as any)
        ws.data.proc = proc
        void proc.exited.then(() => ws.close(1000, 'session ended'))
      },
      message(ws, raw) {
        const term = (ws.data.proc as any)?.terminal
        if (!term || typeof raw !== 'string') return
        let msg: any
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }
        if (msg?.t === 'i' && typeof msg.d === 'string') term.write(msg.d)
        else if (msg?.t === 'r' && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
          term.resize(Math.min(Math.max(msg.c, 20), 500), Math.min(Math.max(msg.r, 5), 200))
        }
      },
      close(ws) {
        // Ends this browser's view only; the tmux session keeps running.
        ws.data.proc?.kill()
        const session = (ws.data as any).session as Session | undefined
        if (session?.sockets.delete(ws) && session.sockets.size === 0) session.idleSince = Date.now()
      },
    },
  })
  host.log(
    `web: terminal on port ${server.port} (${passwordOnly ? 'password only' : host.password ? 'password + Discord approval' : 'Discord approval'}` +
      `${host.trustProxy ? ', behind a trusted proxy' : ''})`,
  )
  return server
}
