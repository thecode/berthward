// Tests for the task scheduler (tasks.ts): what one tick of the once-a-minute
// clock does. The scheduler is the real one; "Discord" is a function that
// records what would be posted and can be told to fail, and the tasks are
// small shell scripts in a temporary folder.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BODY_GRACE_MS, Tasks } from './tasks'

const cleanup: string[] = []
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-test-'))
  cleanup.push(dir)
  const tasksDir = join(dir, 'tasks')
  const stateFile = join(dir, 'tasks.json')
  mkdirSync(tasksDir)
  const posts: Array<{ text: string; extra?: any }> = []
  const env = { reachable: true, attempts: 0 }
  const tasks = new Tasks({
    post: async (text, extra) => {
      env.attempts++
      if (!env.reachable) return null // Discord cannot be reached
      posts.push({ text, extra })
      return {} as any
    },
    log: () => {},
    tasksDir,
    stateFile,
    workdir: dir,
    model: '',
  })

  /** A script task whose output and exit status come from two files, so they can change without changing the task. */
  const write = (name: string, schedule: string, opts: { enabled?: boolean; script?: string } = {}) => {
    const d = join(tasksDir, name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'task.json'), JSON.stringify({ kind: 'script', schedule, enabled: opts.enabled ?? true }))
    writeFileSync(join(d, 'check.sh'), opts.script ?? 'cat out 2>/dev/null; exit "$(cat code 2>/dev/null || echo 0)"\n')
    return d
  }
  const result = (name: string, out: string, code: number) => {
    writeFileSync(join(tasksDir, name, 'out'), out)
    writeFileSync(join(tasksDir, name, 'code'), String(code))
  }
  const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { approved: {}, asked: {}, runs: {} })
  const until = async (check: () => unknown, ms = 5000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out. Posts so far:\n${posts.map(p => '  ' + p.text.slice(0, 100)).join('\n')}`)
      await Bun.sleep(15)
    }
    // Let the scheduler finish what it was doing when the condition became
    // true (it records "asked" right after the post returns). In real use the
    // next tick is a minute away; in a test it is the next line.
    await Bun.sleep(15)
  }
  /** Clicks Approve on the newest approval request. */
  const approve = () => {
    const request = posts.findLast(p => p.extra?.components)!
    const id: string = request.extra.components[0].toJSON().components[0].custom_id
    const [, , name, hash] = id.split(':')
    return tasks.onButton('approve', name, hash, 'Tester')
  }
  /** One tick, then wait until the task's run has been recorded. */
  const tickAndRun = async (name: string, when: Date) => {
    const before = state().runs[name]?.lastRun ?? 0
    tasks.tick(when)
    await until(() => (state().runs[name]?.lastRun ?? 0) > before)
  }
  return { tasks, posts, env, write, result, state, until, approve, tickAndRun, tasksDir }
}

// Local times; a schedule of "0 * * * *" fires at ten o'clock and not at half past.
const TEN = new Date('2026-03-04T10:00:20')
const HALF_PAST = new Date('2026-03-04T10:30:20')
const ELEVEN = new Date('2026-03-04T11:00:20')
const NOON = new Date('2026-03-04T12:00:20')
const ONE = new Date('2026-03-04T13:00:20')

describe('approval', () => {
  test('a new task is shown for approval once, and does not run before it is approved', async () => {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.result('disk', 'disk 2 is failing', 1)
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    expect(t.posts[0].text).toContain('Task `disk`** is new and needs your approval')
    expect(t.posts[0].text).toContain('cat out') // the script is shown
    t.tasks.tick(ELEVEN)
    await Bun.sleep(200)
    expect(t.posts.length).toBe(1) // not asked twice, not run
    expect(t.state().runs.disk).toBeUndefined()
  })

  test('a request that could not be posted is asked again on the next tick', async () => {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.env.reachable = false
    t.tasks.tick(TEN)
    await t.until(() => t.env.attempts === 1)
    expect(t.state().asked.disk).toBeUndefined()
    t.env.reachable = true
    t.tasks.tick(HALF_PAST)
    await t.until(() => t.posts.length === 1)
    expect(t.posts[0].text).toContain('needs your approval')
  })

  test('a changed task needs a new approval and does not run meanwhile', async () => {
    const t = setup()
    const d = t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    expect(t.approve()).toContain('approved by Tester')

    writeFileSync(join(d, 'check.sh'), 'echo changed; exit 1\n')
    t.tasks.tick(ELEVEN)
    await t.until(() => t.posts.length === 2)
    expect(t.posts[1].text).toContain('was changed and needs your approval')
    await Bun.sleep(200)
    expect(t.state().runs.disk).toBeUndefined()
  })

  test('a disabled task is neither asked about nor run', async () => {
    const t = setup()
    t.write('disk', '* * * * *', { enabled: false })
    t.tasks.tick(TEN)
    await Bun.sleep(200)
    expect(t.posts.length).toBe(0)
    expect(t.env.attempts).toBe(0)
  })
})

describe('what the approval request shows', () => {
  test('the settings, and a long script attached in full', async () => {
    const t = setup()
    const long = `# ${'x'.repeat(3000)}
echo the-last-line
`
    t.write('disk', '0 * * * *', { script: long })
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    const ask = t.posts[0]
    expect(ask.text).toContain('`task.json`: `{"kind":"script","schedule":"0 * * * *","enabled":true}`')
    expect(ask.text).toContain('(cut: the complete check.sh is attached)')
    expect(ask.text).not.toContain('the-last-line')
    expect(ask.extra.files.length).toBe(1)
    expect(ask.extra.files[0].name).toBe('check.sh')
    expect(ask.extra.files[0].attachment.toString('utf8')).toBe(long)
  })

  test('a short script is shown whole, with nothing attached', async () => {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    expect(t.posts[0].extra.files).toEqual([])
  })
})

describe('the clock', () => {
  test('an approved task runs in its minute only', async () => {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.result('disk', 'disk 2 is failing', 1)
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()

    t.tasks.tick(HALF_PAST)
    await Bun.sleep(250)
    expect(t.state().runs.disk).toBeUndefined()

    await t.tickAndRun('disk', ELEVEN)
    expect(t.posts.at(-1)!.text).toBe('🚨 **disk**\n```\ndisk 2 is failing\n```')
  })

  test('a quiet task posts nothing', async () => {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()
    await t.tickAndRun('disk', ELEVEN)
    expect(t.posts.length).toBe(1) // only the approval request
    expect(t.state().runs.disk.lastResult).toBe('quiet')
  })
})

describe('alerts', () => {
  async function failing() {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.result('disk', 'disk 2 is failing', 1)
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()
    return t
  }

  test('the same failure is reported once; a different one and the recovery are reported', async () => {
    const t = await failing()
    await t.tickAndRun('disk', ELEVEN)
    expect(t.posts.length).toBe(2)

    await t.tickAndRun('disk', NOON)
    expect(t.posts.length).toBe(2) // same output: no repeat

    t.result('disk', 'disk 2 is failing\ndisk 3 is failing', 1)
    await t.tickAndRun('disk', ONE)
    expect(t.posts.at(-1)!.text).toContain('disk 3 is failing')
    expect(t.posts.length).toBe(3)

    t.result('disk', '', 0)
    await t.tickAndRun('disk', new Date('2026-03-04T14:00:20'))
    expect(t.posts.at(-1)!.text).toContain('✅ **disk** is back to normal.')
  })

  test('an alert that could not be posted goes out after the next run', async () => {
    const t = await failing()
    t.env.reachable = false
    await t.tickAndRun('disk', ELEVEN)
    expect(t.posts.length).toBe(1) // nothing got through
    expect(t.state().runs.disk.lastResult).toBe('undelivered')

    t.env.reachable = true
    await t.tickAndRun('disk', NOON) // the same failure, but the user has not heard of it yet
    expect(t.posts.at(-1)!.text).toContain('🚨 **disk**')
    expect(t.posts.length).toBe(2)

    await t.tickAndRun('disk', ONE)
    expect(t.posts.length).toBe(2) // now it has been delivered, so no repeat
  })

  test('a recovery that could not be posted is sent later too', async () => {
    const t = await failing()
    await t.tickAndRun('disk', ELEVEN)
    t.result('disk', '', 0)
    t.env.reachable = false
    await t.tickAndRun('disk', NOON)
    t.env.reachable = true
    await t.tickAndRun('disk', ONE)
    expect(t.posts.at(-1)!.text).toContain('is back to normal')
  })
})

describe('housekeeping', () => {
  test('a deleted task loses its approval and history', async () => {
    const t = setup()
    const d = t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()
    await t.tickAndRun('disk', ELEVEN)
    expect(t.state().approved.disk).toBeDefined()

    rmSync(d, { recursive: true })
    t.tasks.tick(NOON)
    await t.until(() => t.state().approved.disk === undefined)
    expect(t.state().runs.disk).toBeUndefined()
    expect(t.state().asked.disk).toBeUndefined()
  })

  test('a tasks folder that cannot be read forgets nothing', async () => {
    const t = setup()
    t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()
    // A file where the folder should be: reading it fails, but not with "does not exist".
    renameSync(t.tasksDir, t.tasksDir + '.away')
    writeFileSync(t.tasksDir, 'not a folder')
    t.tasks.tick(ELEVEN)
    await Bun.sleep(150)
    expect(t.state().approved.disk).toBeDefined()
    rmSync(t.tasksDir)
    renameSync(t.tasksDir + '.away', t.tasksDir)
    t.result('disk', 'still watched', 1)
    await t.tickAndRun('disk', NOON)
    expect(t.posts.at(-1)!.text).toContain('still watched')
  })

  test('a broken task that is deleted is forgotten too', async () => {
    const t = setup()
    const d = t.write('disk', '0 * * * *')
    writeFileSync(join(d, 'task.json'), '{ not json')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    expect(t.tasks.list()).toContain('⚠️')
    rmSync(d, { recursive: true })
    t.tasks.tick(ELEVEN)
    await Bun.sleep(100)
    expect(t.tasks.list()).toContain('No tasks yet')
  })

  test('a task whose script is not written yet is not reported as broken', async () => {
    const t = setup()
    const d = join(t.tasksDir, 'disk')
    mkdirSync(d)
    writeFileSync(join(d, 'task.json'), JSON.stringify({ kind: 'script', schedule: '0 * * * *' }))
    t.tasks.tick(TEN)
    await Bun.sleep(150)
    expect(t.posts.length).toBe(0)
    expect(t.tasks.list()).not.toContain('⚠️')

    // The second file arrives: the only message is the approval request.
    writeFileSync(join(d, 'check.sh'), 'exit 0\n')
    t.tasks.tick(ELEVEN)
    await t.until(() => t.posts.length === 1)
    expect(t.posts[0].text).toContain('Task `disk`** is new and needs your approval')
  })

  test('a script that is still missing after a while is reported', async () => {
    const t = setup()
    const d = join(t.tasksDir, 'disk')
    mkdirSync(d)
    writeFileSync(join(d, 'task.json'), JSON.stringify({ kind: 'script', schedule: '0 * * * *' }))
    const old = new Date(Date.now() - BODY_GRACE_MS - 1000)
    utimesSync(join(d, 'task.json'), old, old)
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    expect(t.posts[0].text).toContain('Task `disk` is not usable: check.sh is missing')
  })

  test('an approved task whose script is briefly away keeps its approval', async () => {
    const t = setup()
    const d = t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()
    const script = readFileSync(join(d, 'check.sh'), 'utf8')

    rmSync(join(d, 'check.sh'))
    const now = new Date()
    utimesSync(join(d, 'task.json'), now, now)
    t.tasks.tick(ELEVEN)
    await Bun.sleep(150)
    expect(t.posts.length).toBe(1)

    writeFileSync(join(d, 'check.sh'), script)
    t.result('disk', 'still failing', 1)
    await t.tickAndRun('disk', NOON)
    expect(t.posts.at(-1)!.text).toContain('still failing')
  })

  test('a broken task is reported once and keeps its approval', async () => {
    const t = setup()
    const d = t.write('disk', '0 * * * *')
    t.tasks.tick(TEN)
    await t.until(() => t.posts.length === 1)
    t.approve()
    const good = readFileSync(join(d, 'task.json'), 'utf8')

    writeFileSync(join(d, 'task.json'), '{ not json')
    t.tasks.tick(ELEVEN)
    await t.until(() => t.posts.length === 2)
    expect(t.posts[1].text).toContain('Task `disk` is not usable: task.json is not valid JSON')
    t.tasks.tick(NOON)
    await Bun.sleep(150)
    expect(t.posts.length).toBe(2)

    // Put back exactly as approved: it runs again without a new request.
    writeFileSync(join(d, 'task.json'), good)
    t.result('disk', 'still failing', 1)
    await t.tickAndRun('disk', ONE)
    expect(t.posts.at(-1)!.text).toContain('still failing')
  })
})
