#!/usr/bin/env bun
// web-only — the web terminal without the Discord bridge.
//
// Started by the entrypoint when the web terminal is on, no Discord bot is
// configured and a password is set. Nobody can be asked to approve a sign-in
// here, so the password is the only factor: it must be long, wrong tries lock
// an address out, and every sign-in is written to the container log.
import { parseSessionHours } from './lib'
import { PASSWORD_ONLY_MIN, startWeb } from './web'

const log = (msg: string) => console.log(`web: ${msg.replace(/^web: /, '')}`)
const flag = (name: string) => /^(true|1|yes)$/i.test(process.env[name] ?? '')

const password = process.env.WEB_PASSWORD ?? ''
// The password is only for this process: never hand it to Claude or its tools.
delete process.env.WEB_PASSWORD

if (password.length < PASSWORD_ONLY_MIN) {
  log(
    `not started: without the Discord bridge the web terminal needs "Web Terminal Password" with at least ${PASSWORD_ONLY_MIN} characters.`,
  )
  process.exit(64)
}

try {
  startWeb({
    port: Number(process.env.WEB_PORT ?? 7682),
    password,
    session: process.env.TMUX_SESSION ?? 'main',
    ttlHours: parseSessionHours(process.env.WEB_SESSION_HOURS),
    log,
    trustProxy: flag('WEB_TRUST_PROXY'),
  })
} catch (e) {
  log(`could not start: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
