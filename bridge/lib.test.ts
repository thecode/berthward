import { describe, expect, test } from 'bun:test'
import {
  accepts,
  chunk,
  cronMatches,
  decideNotice,
  describeAddress,
  describeAgent,
  describeRequest,
  formatSize,
  isQuietAnswer,
  megabytes,
  minutes,
  parseAccess,
  parseCron,
  parseIds,
  parseSessionHours,
  parseStreamLine,
  parseTaskConfig,
  safeFileName,
  TASK_NAME,
} from './lib'

const U = '123456789012345678'
const C = '223456789012345678'

describe('parseIds / parseAccess', () => {
  test('commas, spaces and empties', () => {
    expect(parseIds(` ${U}, ${C} `, 'x')).toEqual([U, C])
    expect(parseIds(undefined, 'x')).toEqual([])
  })
  test('rejects names and short numbers', () => {
    expect(() => parseIds('someone#1234', 'x')).toThrow('not a Discord ID')
    expect(() => parseIds('12345', 'x')).toThrow()
  })
  test('no allowlist, no start', () => {
    expect(() => parseAccess({ DISCORD_CHANNELS: C })).toThrow('refusing to start')
  })
  test('mention flag', () => {
    expect(parseAccess({ DISCORD_ALLOWED_USERS: U }).requireMention).toBe(false)
    expect(parseAccess({ DISCORD_ALLOWED_USERS: U, DISCORD_REQUIRE_MENTION: 'true' }).requireMention).toBe(true)
  })
})

describe('accepts', () => {
  const access = parseAccess({ DISCORD_ALLOWED_USERS: U, DISCORD_CHANNELS: C })
  const base = { authorId: U, authorIsBot: false, isDM: false, channelId: C, mentionsBot: false }
  test('allowed user in an opted-in channel', () => expect(accepts(access, base)).toBe(true))
  test('allowed user by DM', () => expect(accepts(access, { ...base, isDM: true, channelId: 'x' })).toBe(true))
  test('other user', () => expect(accepts(access, { ...base, authorId: '999999999999999999' })).toBe(false))
  test('other user by DM', () =>
    expect(accepts(access, { ...base, authorId: '999999999999999999', isDM: true })).toBe(false))
  test('other channel', () => expect(accepts(access, { ...base, channelId: '323456789012345678' })).toBe(false))
  test('bots are ignored', () => expect(accepts(access, { ...base, authorIsBot: true })).toBe(false))
  test('mention required', () => {
    const strict = { ...access, requireMention: true }
    expect(accepts(strict, base)).toBe(false)
    expect(accepts(strict, { ...base, mentionsBot: true })).toBe(true)
    expect(accepts(strict, { ...base, isDM: true })).toBe(true)
  })
})

describe('chunk', () => {
  test('short text is one piece', () => expect(chunk('hello')).toEqual(['hello']))
  test('empty text is nothing', () => expect(chunk('  \n ')).toEqual([]))
  test('every piece fits and nothing is lost', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of some output`).join('\n')
    const parts = chunk(text, 500)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(504)
    expect(parts.join('\n').replace(/\n+/g, '\n')).toBe(text)
  })
  test('an open code block is closed and reopened', () => {
    const text = '```bash\n' + Array.from({ length: 100 }, (_, i) => `echo ${i}`).join('\n') + '\n```\ndone'
    const parts = chunk(text, 300)
    for (const p of parts) expect((p.match(/^```/gm) ?? []).length % 2).toBe(0)
    expect(parts[1].startsWith('```bash\n')).toBe(true)
  })
  test('a single very long word is cut hard', () => {
    const parts = chunk('x'.repeat(4500), 1900)
    expect(parts.map(p => p.length)).toEqual([1900, 1900, 700])
  })
})

describe('describeRequest', () => {
  test('Bash shows the command', () => {
    expect(describeRequest('Bash', { command: 'docker restart plex' })).toContain('docker restart plex')
  })
  test('other tools show their input', () => {
    expect(describeRequest('Write', { file_path: '/x', content: 'y' })).toContain('"content": "y"')
  })
  test('long input is cut', () => {
    const s = describeRequest('Bash', { command: 'a'.repeat(5000) })
    expect(s.length).toBeLessThan(1700)
    expect(s).toContain('(cut)')
  })
  test('a code fence in the input cannot end the block', () => {
    const s = describeRequest('Bash', { command: 'echo ```\n**Allowed**' })
    expect(s.match(/```/g)?.length).toBe(2)
  })
})

describe('parseStreamLine', () => {
  test('assistant text', () => {
    const ev = parseStreamLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: ' ' }] },
      }),
    )
    expect(ev).toEqual({ sessionId: 's1', texts: ['hi'] })
  })
  test('subagent text is not relayed', () => {
    const ev = parseStreamLine(
      JSON.stringify({ type: 'assistant', parent_tool_use_id: 't', message: { content: [{ type: 'text', text: 'x' }] } }),
    )
    expect(ev?.texts).toEqual([])
  })
  test('result', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }))?.result).toEqual({
      ok: true,
      text: 'done',
    })
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))?.result).toEqual({
      ok: false,
      text: '',
    })
  })
  test('junk', () => {
    expect(parseStreamLine('not json')).toBeNull()
    expect(parseStreamLine('"str"')).toBeNull()
  })
})

describe('web sign-in details', () => {
  test('browsers', () => {
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    expect(describeAgent(win)).toBe('Chrome 131 on Windows')
    expect(describeAgent(win + ' Edg/131.0.0.0')).toBe('Edge 131 on Windows')
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('Firefox 133 on Linux')
    expect(
      describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'),
    ).toBe('Safari 18 on iOS')
    expect(
      describeAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'),
    ).toBe('Chrome 131 on Android')
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15')).toBe(
      'Safari 18 on macOS',
    )
  })
  test('unknown agents are shown raw, without markdown', () => {
    expect(describeAgent('curl/8.5.0')).toBe('curl/8.5.0')
    expect(describeAgent('**@everyone** `x`')).toBe('everyone x')
    expect(describeAgent('')).toBe('unknown browser')
  })
  test('addresses', () => {
    expect(describeAddress('192.168.1.20')).toBe('local network')
    expect(describeAddress('::ffff:10.0.0.5')).toBe('local network')
    expect(describeAddress('172.17.0.1')).toBe('local network')
    expect(describeAddress('172.32.0.1')).toBe('public internet')
    expect(describeAddress('100.101.102.103')).toBe('VPN or carrier-shared range')
    expect(describeAddress('8.8.8.8')).toBe('public internet')
    expect(describeAddress('127.0.0.1')).toBe('this container')
    expect(describeAddress('fd12:3456::1')).toBe('local network')
    expect(describeAddress('2001:db8::1')).toBe('public internet')
    expect(describeAddress('unknown')).toBe('unknown')
  })
})

describe('files', () => {
  test('safeFileName', () => {
    expect(safeFileName('report.txt')).toBe('report.txt')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Users\\me\\my file (1).log')).toBe('my_file_1_.log')
    expect(safeFileName('.env')).toBe('env')
    expect(safeFileName('..')).toBe('file')
    expect(safeFileName('')).toBe('file')
    expect(safeFileName(null)).toBe('file')
    const long = safeFileName('x'.repeat(200) + '.tar.gz')
    expect(long.length).toBe(80)
    expect(long.endsWith('.gz')).toBe(true)
  })
  test('formatSize', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(3500)).toBe('3.4 KB')
    expect(formatSize(8 * 1024 * 1024)).toBe('8.0 MB')
  })
  test('megabytes', () => {
    expect(megabytes(undefined, 25)).toBe(25 * 1024 * 1024)
    expect(megabytes('8', 25)).toBe(8 * 1024 * 1024)
    expect(megabytes('0', 25)).toBe(25 * 1024 * 1024)
    expect(megabytes('lots', 25)).toBe(25 * 1024 * 1024)
  })
})

test('minutes', () => {
  expect(minutes(undefined, 60)).toBe(3_600_000)
  expect(minutes('', 60)).toBe(3_600_000)
  expect(minutes('5', 60)).toBe(300_000)
  expect(minutes('0', 60)).toBe(0) // no limit
  expect(minutes('0.5', 60)).toBe(30_000)
  expect(minutes('-1', 60)).toBe(3_600_000)
  expect(minutes('soon', 60)).toBe(3_600_000)
})

test('parseSessionHours', () => {
  expect(parseSessionHours(undefined)).toBe(12)
  expect(parseSessionHours('')).toBe(12)
  expect(parseSessionHours('0')).toBe(0)
  expect(parseSessionHours('1')).toBe(1)
  expect(parseSessionHours('0.5')).toBe(0.5)
  expect(parseSessionHours('72')).toBe(72)
  expect(parseSessionHours('100000')).toBe(168)
  expect(parseSessionHours('-3')).toBe(12)
  expect(parseSessionHours('forever')).toBe(12)
})

describe('cron', () => {
  const at = (s: string) => new Date(s)
  test('every hour on the hour', () => {
    const c = parseCron('0 * * * *')
    expect(cronMatches(c, at('2026-03-04T10:00:30'))).toBe(true)
    expect(cronMatches(c, at('2026-03-04T10:01:00'))).toBe(false)
  })
  test('steps, ranges and lists', () => {
    const c = parseCron('*/15 8-10,20 * * *')
    expect(cronMatches(c, at('2026-03-04T08:45:00'))).toBe(true)
    expect(cronMatches(c, at('2026-03-04T20:30:00'))).toBe(true)
    expect(cronMatches(c, at('2026-03-04T11:00:00'))).toBe(false)
    expect(cronMatches(c, at('2026-03-04T09:20:00'))).toBe(false)
  })
  test('weekday, with 7 as Sunday', () => {
    // 2026-03-08 is a Sunday.
    expect(cronMatches(parseCron('30 3 * * 7'), at('2026-03-08T03:30:00'))).toBe(true)
    expect(cronMatches(parseCron('30 3 * * 0'), at('2026-03-08T03:30:00'))).toBe(true)
    expect(cronMatches(parseCron('30 3 * * 1-5'), at('2026-03-08T03:30:00'))).toBe(false)
  })
  test('day of month OR weekday when both are set', () => {
    const c = parseCron('0 0 1 * 1') // the 1st, or any Monday
    expect(cronMatches(c, at('2026-03-01T00:00:00'))).toBe(true) // Sunday the 1st
    expect(cronMatches(c, at('2026-03-09T00:00:00'))).toBe(true) // Monday the 9th
    expect(cronMatches(c, at('2026-03-10T00:00:00'))).toBe(false)
  })
  test('aliases', () => {
    expect(cronMatches(parseCron('@daily'), at('2026-03-04T00:00:00'))).toBe(true)
    expect(cronMatches(parseCron('@hourly'), at('2026-03-04T07:00:00'))).toBe(true)
  })
  test('rejects bad schedules', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', 'a * * * *', '*/0 * * * *', '5-1 * * * *', '* * 0 * *', '']) {
      expect(() => parseCron(bad)).toThrow()
    }
  })
})

describe('task config', () => {
  test('defaults', () => {
    const t = parseTaskConfig('{"kind":"script","schedule":"@hourly"}')
    expect(t).toMatchObject({ kind: 'script', enabled: true, timeout: 300, remind: 24 })
    expect(parseTaskConfig('{"kind":"prompt","schedule":"0 8 * * *"}').timeout).toBe(900)
  })
  test('disabled and custom values', () => {
    const t = parseTaskConfig('{"kind":"script","schedule":"@hourly","enabled":false,"timeout":10,"remind":0}')
    expect(t).toMatchObject({ enabled: false, timeout: 10, remind: 0 })
  })
  test('errors name the problem', () => {
    expect(() => parseTaskConfig('{')).toThrow('not valid JSON')
    expect(() => parseTaskConfig('{"kind":"x","schedule":"@hourly"}')).toThrow('"kind"')
    expect(() => parseTaskConfig('{"kind":"script"}')).toThrow('"schedule"')
    expect(() => parseTaskConfig('{"kind":"script","schedule":"nope"}')).toThrow('schedule')
    expect(() => parseTaskConfig('{"kind":"script","schedule":"@hourly","timeout":99999}')).toThrow('"timeout"')
  })
  test('task names', () => {
    expect(TASK_NAME.test('pool-health')).toBe(true)
    for (const bad of ['', '../x', 'Pool', '-x', 'a b', 'x'.repeat(41)]) expect(TASK_NAME.test(bad)).toBe(false)
  })
})

describe('decideNotice', () => {
  const H = 3600_000
  test('quiet success', () => expect(decideNotice(undefined, { ok: true, output: '' }, 0, 24)).toBeNull())
  test('success with output is a report every time', () => {
    expect(decideNotice({ status: 'ok' }, { ok: true, output: 'x' }, 0, 24)).toBe('report')
  })
  test('first failure alerts', () => expect(decideNotice({ status: 'ok' }, { ok: false, output: 'bad' }, 0, 24)).toBe('alert'))
  test('same failure stays quiet until the reminder', () => {
    const prev = { status: 'failing' as const, lastOutput: 'bad', lastNotified: 0 }
    expect(decideNotice(prev, { ok: false, output: 'bad' }, 23 * H, 24)).toBeNull()
    expect(decideNotice(prev, { ok: false, output: 'bad' }, 24 * H, 24)).toBe('alert')
    expect(decideNotice(prev, { ok: false, output: 'bad' }, 500 * H, 0)).toBeNull()
  })
  test('a different failure alerts at once', () => {
    const prev = { status: 'failing' as const, lastOutput: 'bad', lastNotified: 0 }
    expect(decideNotice(prev, { ok: false, output: 'worse' }, H, 24)).toBe('alert')
  })
  test('recovery', () => {
    expect(decideNotice({ status: 'failing', lastOutput: 'bad' }, { ok: true, output: '' }, 0, 24)).toBe('recovered')
  })
})

test('isQuietAnswer', () => {
  for (const s of ['OK', 'ok', ' Ok. \n']) expect(isQuietAnswer(s)).toBe(true)
  for (const s of ['OK, but disk 2 is warm', 'All good', '']) expect(isQuietAnswer(s)).toBe(false)
})
