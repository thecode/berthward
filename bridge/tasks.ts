// Scheduled monitoring tasks, run by the bridge and reported on Discord.
//
// A task is a folder <tasks dir>/<name>/ with:
//   task.json   {"kind": "script" | "prompt", "schedule": "<cron>", ...}
//   check.sh    for a script task: exit 0 and no output = quiet; exit 0 with
//               output = a report; any other exit = an alert (output attached)
//   prompt.md   for a prompt task: a question for Claude, run headless with
//               no one to ask (anything that would need permission is denied);
//               the answer is posted unless it is exactly "OK"
//
// A task only runs after the user approved its exact content on Discord. Any
// change to task.json or to the script/prompt needs a new approval, so a task
// Claude wrote or edited cannot start running on its own. The task folders are
// re-read every minute; nothing needs restarting after an edit.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Message } from 'discord.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cronMatches,
  decideNotice,
  isQuietAnswer,
  parseTaskConfig,
  TASK_NAME,
  type TaskConfig,
  type TaskRunState,
} from './lib'

export interface TaskHost {
  /** Post to the alert chat. */
  post(text: string, extra?: object): Promise<Message | null>
  log(msg: string): void
  tasksDir: string
  stateFile: string
  workdir: string
  model: string
}

interface Task {
  name: string
  dir: string
  config: TaskConfig
  /** task.json as written. */
  json: string
  body: string
  hash: string
}

/** How much of a task's script or prompt fits in the approval request; a longer one is also attached in full. */
const TASK_SHOWN = 1200

interface TasksState {
  /** name → content hash the user approved. */
  approved: Record<string, string>
  /** name → content hash the user rejected or was already asked about. */
  asked: Record<string, string>
  runs: Record<string, TaskRunState & { lastRun?: number; lastResult?: string }>
}

const PROMPT_TASK_SYSTEM = [
  'This is a scheduled monitoring task on an Unraid server. Nobody is present: you cannot ask questions, and any tool call that would need permission is denied, so use read-only commands.',
  'If there is nothing the owner needs to know, reply with exactly: OK',
  'Otherwise reply with a short report for Discord (it renders bold, lists and code blocks, not tables): lead with what needs attention, then the evidence. Do not describe what you checked when all is well.',
].join('\n')

const MAX_OUTPUT = 6000

export class Tasks {
  private state: TasksState
  private runningNow = new Set<string>()
  private promptChain: Promise<void> = Promise.resolve()
  private problems = new Map<string, string>()
  /** The tasks folder could not be read on the last scan (not: it does not exist). */
  private scanFailed = false
  private asking = new Set<string>()

  constructor(private host: TaskHost) {
    this.state = this.load()
  }

  private load(): TasksState {
    try {
      const s = JSON.parse(readFileSync(this.host.stateFile, 'utf8'))
      return { approved: s.approved ?? {}, asked: s.asked ?? {}, runs: s.runs ?? {} }
    } catch {
      return { approved: {}, asked: {}, runs: {} }
    }
  }

  private save(): void {
    const tmp = this.host.stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.host.stateFile)
  }

  /** Reads every task folder. Broken ones are reported once per distinct problem. */
  scan(): Task[] {
    const out: Task[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.host.tasksDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
    } catch (e) {
      // No folder means no tasks. Any other failure (a share that is briefly
      // away) must not be mistaken for "every task was deleted".
      this.scanFailed = (e as NodeJS.ErrnoException)?.code !== 'ENOENT'
      return out
    }
    this.scanFailed = false
    // A problem is forgotten with its folder.
    for (const name of [...this.problems.keys()]) {
      if (!names.includes(name) || !existsSync(join(this.host.tasksDir, name, 'task.json'))) this.problems.delete(name)
    }
    for (const name of names) {
      const dir = join(this.host.tasksDir, name)
      if (!existsSync(join(dir, 'task.json'))) continue
      try {
        if (!TASK_NAME.test(name)) throw new Error('the folder name must be lowercase letters, digits, - or _')
        const json = readFileSync(join(dir, 'task.json'), 'utf8')
        const config = parseTaskConfig(json)
        const bodyFile = config.kind === 'script' ? 'check.sh' : 'prompt.md'
        if (!existsSync(join(dir, bodyFile))) throw new Error(`${bodyFile} is missing`)
        const body = readFileSync(join(dir, bodyFile), 'utf8')
        const hash = createHash('sha256').update(json).update('\0').update(body).digest('hex')
        out.push({ name, dir, config, json, body, hash })
        this.problems.delete(name)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (this.problems.get(name) !== msg) {
          this.problems.set(name, msg)
          void this.host.post(`⚠️ Task \`${name}\` is not usable: ${msg}`)
        }
      }
    }
    return out
  }

  private isApproved(t: Task): boolean {
    return this.state.approved[t.name] === t.hash
  }

  /** Shows a task's content with Approve / Reject buttons. */
  async askApproval(t: Task): Promise<void> {
    if (this.asking.has(t.name)) return
    this.asking.add(t.name)
    try {
      await this.askApprovalNow(t)
    } finally {
      this.asking.delete(t.name)
    }
  }

  private async askApprovalNow(t: Task): Promise<void> {
    const lang = t.config.kind === 'script' ? 'bash' : 'md'
    let body = t.body.replace(/```/g, '`\u200b``')
    // Approve covers the whole file, so a long one is attached in full.
    const bodyFile = t.config.kind === 'script' ? 'check.sh' : 'prompt.md'
    const cut = t.body.length > TASK_SHOWN
    if (cut) body = body.slice(0, TASK_SHOWN) + `\n… (cut: the complete ${bodyFile} is attached)`
    const files = cut ? [{ attachment: Buffer.from(t.body, 'utf8'), name: bodyFile }] : []
    let settings = t.json
    try {
      settings = JSON.stringify(JSON.parse(t.json))
    } catch {}
    settings = settings.replace(/`/g, "'").slice(0, 300)
    const changed = this.state.approved[t.name] !== undefined
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`task:approve:${t.name}:${t.hash.slice(0, 16)}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`task:reject:${t.name}:${t.hash.slice(0, 16)}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )
    const sent = await this.host.post(
      `🗓️ **Task \`${t.name}\`** ${changed ? 'was changed and' : 'is new and'} needs your approval before it runs.\n` +
        `${t.config.kind} task, schedule \`${t.config.schedule}\`` +
        (t.config.kind === 'script'
          ? ' (runs as root in the container, without further prompts)'
          : ' (Claude runs it read-only; each run uses your Claude plan)') +
        `\n\`task.json\`: \`${settings}\`` +
        `\n\`\`\`${lang}\n${body}\n\`\`\``,
      { components: [row], files },
    )
    // Not delivered (Discord unreachable): the next tick asks again.
    if (sent) {
      this.state.asked[t.name] = t.hash
      this.save()
    }
  }

  /** A click on a task button. Returns the text to put on the message, or null if it is stale. */
  onButton(verdict: string, name: string, hashPrefix: string, user: string): string | null {
    const t = this.scan().find(x => x.name === name)
    if (!t || !t.hash.startsWith(hashPrefix)) return '♻️ This task changed since; see the newer request.'
    if (verdict === 'approve') {
      this.state.approved[name] = t.hash
      this.save()
      return `✅ Task \`${name}\` approved by ${user}. It runs on its schedule (\`${t.config.schedule}\`); \`/run ${name}\` runs it now.`
    }
    delete this.state.approved[name]
    this.save()
    return `❌ Task \`${name}\` rejected by ${user}. It will not run. Editing the task asks again.`
  }

  /**
   * Drops approvals and run history of tasks whose folder is gone, so a task
   * created later under the same name starts from nothing. A task that is
   * only broken for the moment keeps its record.
   */
  private forget(present: Set<string>): void {
    let changed = false
    for (const map of [this.state.approved, this.state.asked, this.state.runs] as Array<Record<string, unknown>>) {
      for (const name of Object.keys(map)) {
        if (!present.has(name)) {
          delete map[name]
          changed = true
        }
      }
    }
    if (changed) this.save()
  }

  /** Called once a minute. */
  tick(now: Date): void {
    const tasks = this.scan()
    if (this.scanFailed) return // try again in a minute; nothing is forgotten
    this.forget(new Set([...tasks.map(t => t.name), ...this.problems.keys()]))
    for (const t of tasks) {
      if (!t.config.enabled) continue
      if (!this.isApproved(t)) {
        if (this.state.asked[t.name] !== t.hash) void this.askApproval(t)
        continue
      }
      if (cronMatches(t.config.cron, now)) this.start(t, false)
    }
  }

  private start(t: Task, manual: boolean): void {
    if (this.runningNow.has(t.name)) return
    this.runningNow.add(t.name)
    const job = async () => {
      try {
        await this.run(t, manual)
      } catch (e) {
        this.host.log(`task ${t.name}: ${e instanceof Error ? e.stack : e}`)
      } finally {
        this.runningNow.delete(t.name)
      }
    }
    // Prompt tasks run one at a time; script tasks run side by side.
    if (t.config.kind === 'prompt') this.promptChain = this.promptChain.then(job)
    else void job()
  }

  private async exec(cmd: string[], cwd: string, env: Record<string, string>, stdin: string | null, timeoutS: number) {
    const proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, ...env },
      stdin: stdin === null ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (stdin !== null && proc.stdin) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutS * 1000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    return { stdout, stderr, code, timedOut }
  }

  private async run(t: Task, manual: boolean): Promise<void> {
    let ok: boolean
    let output: string
    if (t.config.kind === 'script') {
      const r = await this.exec(['bash', 'check.sh'], t.dir, { TASK_NAME: t.name, TASK_DIR: t.dir }, null, t.config.timeout)
      ok = r.code === 0 && !r.timedOut
      output = (r.stdout + (ok ? '' : r.stderr)).trim()
      if (r.timedOut) output = `Timed out after ${t.config.timeout} s.\n${output}`.trim()
      else if (!ok && output === '') output = `Exited with status ${r.code} and no output.`
    } else {
      const args = [
        '-p',
        '--output-format', 'json',
        '--permission-prompts', 'none',
        // Read-only: the allow list would let it write in the workspace.
        '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
        '--no-session-persistence',
        '--append-system-prompt', PROMPT_TASK_SYSTEM,
        ...(this.host.model ? ['--model', this.host.model] : []),
      ]
      const r = await this.exec(['claude', ...args], this.host.workdir, {}, t.body, t.config.timeout)
      let result: any = null
      try {
        result = JSON.parse(r.stdout)
      } catch {}
      if (r.timedOut) {
        ok = false
        output = `Timed out after ${t.config.timeout} s.`
      } else if (r.code !== 0 || !result || result.is_error === true) {
        ok = false
        output = `Claude could not run this task: ${(result?.result || r.stderr || `exit ${r.code}`).toString().trim().slice(-800)}`
      } else {
        ok = true
        output = isQuietAnswer(String(result.result ?? '')) ? '' : String(result.result ?? '').trim()
      }
    }
    if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n… (cut)'

    const now = Date.now()
    const prev = this.state.runs[t.name]
    const notice = manual ? (ok ? (output ? 'report' : null) : 'alert') : decideNotice(prev, { ok, output }, now, t.config.remind)
    // A script's output is plain text; Claude's answer is already Discord markdown.
    const shown = t.config.kind === 'script' && output ? '```\n' + output.replace(/```/g, '`\u200b``') + '\n```' : output
    let delivered = true
    if (notice === 'alert') delivered = null !== await this.host.post(`🚨 **${t.name}**\n${shown}`)
    else if (notice === 'recovered') delivered = null !== await this.host.post(`✅ **${t.name}** is back to normal.${shown ? '\n' + shown : ''}`)
    else if (notice === 'report') await this.host.post(`📋 **${t.name}**\n${shown}`)
    else if (manual) await this.host.post(`✅ **${t.name}** ran: nothing to report.`)

    // If an alert or a recovery could not be delivered (Discord unreachable),
    // keep the previous state so the next run posts it again.
    if (!delivered) {
      this.host.log(`task ${t.name}: could not deliver the ${notice} notice; it is sent again after the next run`)
      this.state.runs[t.name] = { ...(prev ?? { status: 'ok' }), lastRun: now, lastResult: 'undelivered' }
    } else {
      this.state.runs[t.name] = {
        status: ok ? 'ok' : 'failing',
        lastOutput: ok ? undefined : output,
        lastNotified: notice === 'alert' ? now : ok ? undefined : prev?.lastNotified,
        lastRun: now,
        lastResult: ok ? (output ? 'report' : 'quiet') : 'alert',
      }
    }
    this.save()
  }

  /** `/run <name>` */
  async runNow(name: string): Promise<string | null> {
    const t = this.scan().find(x => x.name === name)
    if (!t) return `There is no task \`${name}\`. \`/tasks\` lists them.`
    if (!this.isApproved(t)) {
      await this.askApproval(t)
      return null
    }
    if (this.runningNow.has(name)) return `\`${name}\` is already running.`
    this.start(t, true)
    return `▶️ Running \`${name}\`…`
  }

  /** Names of the usable tasks, for command autocomplete. */
  names(): string[] {
    return this.scan().map(t => t.name)
  }

  /** `/tasks` */
  list(): string {
    const tasks = this.scan()
    if (tasks.length === 0 && this.problems.size === 0) {
      return `No tasks yet. Ask me to create one, or add a folder under \`${this.host.tasksDir}\`.`
    }
    const lines = tasks.map(t => {
      const run = this.state.runs[t.name]
      const state = !t.config.enabled
        ? 'disabled'
        : !this.isApproved(t)
          ? 'waiting for approval'
          : this.runningNow.has(t.name)
            ? 'running'
            : run
              ? `last run <t:${Math.floor((run.lastRun ?? 0) / 1000)}:R>: ${run.lastResult}`
              : 'not run yet'
      return `• \`${t.name}\` (${t.config.kind}, \`${t.config.schedule}\`): ${state}`
    })
    for (const [name, msg] of this.problems) lines.push(`• \`${name}\`: ⚠️ ${msg}`)
    return ['**Tasks**', ...lines, '`/run <name>` runs one now.'].join('\n')
  }

  /** Runs `tick` at the start of every minute. */
  startClock(): void {
    mkdirSync(this.host.tasksDir, { recursive: true })
    const arm = () => {
      const wait = 60_000 - (Date.now() % 60_000) + 500
      setTimeout(() => {
        try {
          this.tick(new Date())
        } catch (e) {
          this.host.log(`task tick: ${e instanceof Error ? e.stack : e}`)
        }
        arm()
      }, wait)
    }
    arm()
  }
}
