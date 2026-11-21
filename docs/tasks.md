# Monitoring tasks

A task is a check that runs on a schedule and reports to Discord. Tasks need
the Discord bridge: that is where they report and where you approve them.

The usual way to get one is to ask for it:

> Check every 15 minutes that the backup share has less than 90% used, and
> tell me if not.

Claude writes the task into its own folder and tells you what it checks. A
minute later the bot shows you the task's exact content with **Approve** and
**Reject** buttons. Nothing runs before you approve.

## Two kinds

**Script task.** A shell script decides. This is the right kind for anything
a script can decide: it costs nothing to run and behaves the same every time.

- Exit status 0 with no output: all is well, nothing is posted.
- Exit status 0 with output: posted as a report.
- Any other exit status: an alert, with the output.

**Prompt task.** A question Claude answers on a schedule, for things that
need judgment: a morning summary, "anything unusual in the logs since
yesterday?". Each run uses your Claude plan. It runs with nobody to ask, so
anything that would need your permission is refused; the prompt has to be
answerable with the read-only commands that never ask. An answer of exactly
`OK` posts nothing.

## Alerts are not repeated

A failing script task alerts once. It alerts again when its output changes,
or as a reminder after 24 hours (configurable). When it passes again you get
one "back to normal" message. If Discord cannot be reached, the alert is sent
after a later run.

## The files

Tasks live in the workspace, one folder each:

```
/workspace/tasks/<name>/
  task.json
  check.sh        (script task)
  prompt.md       (prompt task)
```

Folder names use lowercase letters, digits, `-` and `_`.

`task.json`:

```json
{
  "kind": "script",
  "schedule": "*/15 * * * *",
  "enabled": true,
  "timeout": 120,
  "remind": 24
}
```

| Key | Meaning |
|---|---|
| `kind` | `script` or `prompt` |
| `schedule` | Five-field cron, in the container's timezone. `@hourly` and `@daily` also work |
| `enabled` | Optional, default `true`. `false` parks the task without deleting it |
| `timeout` | Optional, seconds. A run that takes longer is stopped and reported |
| `remind` | Optional, hours until a failure that has not changed is reported again. Default 24 |

A script runs inside the container as root, with `bash check.sh`. Use
`host <command>` for host commands, keep it read-only, and make it print
nothing when all is well.

## Approval

A task is approved by its content. Change one character of `task.json`,
`check.sh` or `prompt.md` and the task stops running until you approve the
new version; the request shows what the task now contains. This is what keeps
a script from changing under you: whatever runs unattended is something you
read.

Deleting a task's folder removes its approval and history. A task with a
broken `task.json` is reported once and keeps its approval, so fixing it back
to what you approved needs no new request.

## Commands

| Command | What it does |
|---|---|
| `/tasks` | List the tasks with their schedule and last result |
| `/run <name>` | Run one now. You always get an answer, also when all is well |

## The examples

A new install starts with two tasks, waiting for your approval:

- **`pool-health`** (script, every 15 minutes): alerts when a ZFS pool is not
  healthy, or when an array disk is missing, disabled or has errors.
- **`daily-digest`** (prompt, 08:00): a short morning status of storage,
  containers, VMs and load.

Approve the ones you want and reject or delete the others. They are also good
starting points for your own.

## Limits

- Schedules have one-minute resolution, and a task that is still running is
  not started a second time.
- Tasks stop when the container or the bridge stops, and nothing tells you
  that they did. For checks you depend on, keep a second way to notice.
- Alerts go to one channel. There is no history beyond the channel itself.
