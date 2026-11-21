// Tests for the web terminal's sign-in. The server runs for real on a free
// port; Discord is replaced by a function that records the request and
// answers with a fixed verdict. No tmux session exists, so the terminal
// itself is only tested up to "no session".
import { describe, expect, test } from 'bun:test'
import { startWeb, type SignInInfo, type WebHost } from './web'

function serve(over: Partial<WebHost> = {}, verdict = true) {
  const logs: string[] = []
  const asked: SignInInfo[] = []
  const host: WebHost = {
    port: 0,
    password: '',
    session: 'no-such-session-for-tests',
    ttlHours: 12,
    log: m => logs.push(m),
    approve: async info => {
      asked.push(info)
      return verdict
    },
    ...over,
  }
  const srv = startWeb(host)
  const base = `http://127.0.0.1:${srv.port}`
  const login = (body: object = {}, headers: Record<string, string> = {}) =>
    fetch(`${base}/login`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  /** Polls like the page does until the request is no longer pending. */
  const settle = async (id: string, headers: Record<string, string> = {}) => {
    for (;;) {
      const res = await fetch(`${base}/login/status?id=${id}`, { headers })
      const body = (await res.json()) as { status: string }
      if (body.status !== 'pending') return { status: body.status, cookie: res.headers.get('set-cookie') ?? '' }
      await Bun.sleep(20)
    }
  }
  const cookieValue = (setCookie: string) => setCookie.split(';')[0]
  return { srv, base, logs, asked, login, settle, cookieValue }
}

/** Opens the terminal socket and resolves with the code it is closed with. */
function socketClose(base: string, cookie = ''): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', {
      headers: { origin: base, ...(cookie ? { cookie } : {}) },
    } as any)
    ws.onclose = e => resolve(e.code)
    ws.onerror = () => {}
  })
}

describe('sign-in approved on Discord', () => {
  test('the page offers no password field, and nothing works before sign-in', async () => {
    const t = serve()
    const page = await (await fetch(t.base + '/')).text()
    expect(page).toContain('Sign in with Discord approval')
    expect(page).not.toContain('type="password"')
    expect((await fetch(t.base + '/assets/term.js')).status).toBe(401)
    expect(await socketClose(t.base)).toBe(4401)
    t.srv.stop(true)
  })

  test('a request without our own origin is refused', async () => {
    const t = serve()
    expect((await t.login({}, { origin: 'http://evil.example' })).status).toBe(400)
    const noOrigin = await fetch(t.base + '/login', { method: 'POST', body: '{}' })
    expect(noOrigin.status).toBe(400)
    expect(t.asked.length).toBe(0)
    t.srv.stop(true)
  })

  test('allow: the code matches, the cookie is issued once, the terminal page opens', async () => {
    const t = serve()
    const { id, code } = (await (await t.login()).json()) as { id: string; code: string }
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/)
    expect(t.asked[0].code).toBe(code)
    expect(t.asked[0].where).toBe('this container')
    const first = await t.settle(id)
    expect(first.status).toBe('allowed')
    expect(first.cookie).toContain('HttpOnly')
    expect(first.cookie).toContain('SameSite=Lax')
    expect(first.cookie).toContain('Max-Age=43200')
    expect(first.cookie).not.toContain('Secure')
    // The same request cannot be collected a second time.
    expect((await t.settle(id)).status).toBe('gone')

    const cookie = t.cookieValue(first.cookie)
    expect(await (await fetch(t.base + '/', { headers: { cookie } })).text()).toContain('id="t"')
    expect((await fetch(t.base + '/assets/term.js', { headers: { cookie } })).status).toBe(200)
    // Signed in, but there is no tmux session to attach to.
    expect(await socketClose(t.base, cookie)).toBe(4404)

    // Signing out ends it.
    await fetch(t.base + '/logout', { method: 'POST', headers: { cookie } })
    expect(await (await fetch(t.base + '/', { headers: { cookie } })).text()).toContain('Sign in')
    expect(await socketClose(t.base, cookie)).toBe(4401)
    t.srv.stop(true)
  })

  test('deny: no cookie', async () => {
    const t = serve({}, false)
    const { id } = (await (await t.login()).json()) as { id: string }
    const r = await t.settle(id)
    expect(r.status).toBe('denied')
    expect(r.cookie).toBe('')
    t.srv.stop(true)
  })

  test('0 hours: a cookie without a lifetime', async () => {
    const t = serve({ ttlHours: 0 })
    const { id } = (await (await t.login()).json()) as { id: string }
    const r = await t.settle(id)
    expect(r.status).toBe('allowed')
    expect(r.cookie).not.toContain('Max-Age')
    t.srv.stop(true)
  })

  test('with a password: a wrong one never reaches Discord', async () => {
    const t = serve({ password: 'correct horse' })
    expect(await (await fetch(t.base + '/')).text()).toContain('type="password"')
    expect((await t.login({ password: 'nope' })).status).toBe(403)
    expect(t.asked.length).toBe(0)
    const ok = await t.login({ password: 'correct horse' })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('set-cookie')).toBeNull() // still needs the Discord answer
    expect(t.asked.length).toBe(1)
    t.srv.stop(true)
  })
})

describe('password only (no Discord)', () => {
  test('a short password is refused at start', () => {
    expect(() => serve({ approve: undefined, password: 'short' })).toThrow('at least 12 characters')
    expect(() => serve({ approve: undefined, password: '' })).toThrow()
  })

  test('the right password signs in at once', async () => {
    const t = serve({ approve: undefined, password: 'a long enough password' })
    const page = await (await fetch(t.base + '/')).text()
    expect(page).not.toContain('Discord')
    const res = await t.login({ password: 'a long enough password' })
    expect(((await res.json()) as { status: string }).status).toBe('allowed')
    const cookie = t.cookieValue(res.headers.get('set-cookie') ?? '')
    expect(await (await fetch(t.base + '/', { headers: { cookie } })).text()).toContain('id="t"')
    expect(t.logs.some(l => l.includes('signed in'))).toBe(true)
    t.srv.stop(true)
  })

  test('five wrong passwords lock the address out, even for the right one', async () => {
    const t = serve({ approve: undefined, password: 'a long enough password' })
    for (let i = 0; i < 5; i++) expect((await t.login({ password: 'wrong' })).status).toBe(403)
    const locked = await t.login({ password: 'a long enough password' })
    expect(locked.status).toBe(429)
    expect(locked.headers.get('set-cookie')).toBeNull()
    expect(t.logs.filter(l => l.includes('wrong password')).length).toBe(5)
    t.srv.stop(true)
  }, 15000)

  test('wrong passwords from one address do not keep another address out', async () => {
    const t = serve({ approve: undefined, password: 'a long enough password', trustProxy: true })
    const from = (ip: string) => ({ 'x-forwarded-for': ip })
    for (let i = 0; i < 6; i++) await t.login({ password: 'wrong' }, from('203.0.113.9'))
    const mine = await t.login({ password: 'a long enough password' }, from('198.51.100.7'))
    expect(mine.status).toBe(200)
    expect(mine.headers.get('set-cookie')).toContain('HttpOnly')
    t.srv.stop(true)
  }, 15000)
})

describe('behind a reverse proxy', () => {
  const forwarded = {
    origin: 'https://term.example.com',
    'x-forwarded-host': 'term.example.com',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.9, 198.51.100.7',
  }

  test('trusted: address, host and https come from the proxy', async () => {
    const t = serve({ trustProxy: true })
    const { id } = (await (await t.login({}, forwarded)).json()) as { id: string }
    // The last entry is the one the proxy added; the first is the client's claim.
    expect(t.asked[0].ip).toBe('198.51.100.7')
    expect(t.asked[0].where).toBe('public internet')
    expect(t.asked[0].via).toBe('term.example.com')
    expect(t.asked[0].location).toBe('') // the lookup is off
    const r = await t.settle(id, forwarded)
    expect(r.status).toBe('allowed')
    expect(r.cookie).toContain('Secure')
    t.srv.stop(true)
  })

  test('a sign-in can only be collected from the address that asked', async () => {
    const t = serve({ trustProxy: true })
    const { id } = (await (await t.login({}, forwarded)).json()) as { id: string }
    await Bun.sleep(50)
    const other = await t.settle(id, { 'x-forwarded-for': '192.0.2.50' })
    expect(other.status).toBe('gone')
    expect(other.cookie).toBe('')
    t.srv.stop(true)
  })

  test('not trusted: the same headers are ignored', async () => {
    const t = serve()
    // The forwarded host does not count, so this origin is foreign.
    expect((await t.login({}, forwarded)).status).toBe(400)
    await t.login({}, { 'x-forwarded-for': '203.0.113.9' })
    expect(t.asked[0].ip).not.toBe('203.0.113.9')
    t.srv.stop(true)
  })
})
