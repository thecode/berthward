# Monitoring tasks

A task is a check that runs on a schedule and reports to Discord. Tasks need
the Discord bridge: that is where they report and where you approve them.

The usual way to get one is to ask for it:

> Check every 15 minutes that the backup share has less than 90% used, and
> tell me if not.

Claude writes the task into its own folder and tells you what it checks. A
minute later the bot shows you the task's settings and its script or prompt
with **Approve** and **Reject** buttons. A long script is cut in the message
and attached in full. Nothing runs before you approve.

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

Approval covers `task.json` and the task's one script or prompt, nothing
else. A script that runs or reads another file is not protected against that
file changing, so keep a check in the one file, and be wary of a script that
calls out to others.

A task is approved by its content. Change one character of `task.json`,
`check.sh` or `prompt.md` and the task stops running until you approve the
new version; the request shows what the task now contains. This is what keeps
a script from changing under you: whatever runs unattended is something you
read.

Deleting a task's folder removes its approval and history. A task with a
broken `task.json` is reported once and keeps its approval, so fixing it back
to what you approved needs no new request. A `task.json` without its script
or prompt is taken as still being written and is reported only after five
minutes.

## Commands

| Command | What it does |
|---|---|
| `/tasks` | List the tasks with their schedule and last result |
| `/run <name>` | Run one now. You always get an answer, also when all is well |
| `/run <name> <arguments>` | Run a script task now with arguments, for example `--dry-run` |

### Arguments

Words after the task's name are handed to `check.sh` as its arguments
(`$1`, `$2`, … in the script). What they mean is up to the script: a task
that keeps its own readings between runs can take `--dry-run` to report
without storing a new reading, another can take a different limit for one
run. A script that does not look at its arguments ignores them.

- A run with arguments is answered and then forgotten: it does not count as
  the task's last run, and it changes nothing about which alerts the
  scheduled runs send.
- Scheduled runs never get arguments.
- Words are split at spaces; there is no quoting. Up to 10 words of plain
  letters, digits and punctuation.
- Only script tasks take arguments.
- With the slash command, type the words after the task's name
  (`/run disk-health --dry-run`) and pick the suggestion that shows them, or
  put them in the separate `arguments` field. With `!run` they simply follow
  the name.

To give an existing task an option, ask Claude to add it. That changes the
script, so it needs your approval again.

## The examples

A new install starts with three tasks, waiting for your approval:

- **`pool-health`** (script, every 15 minutes): alerts when a ZFS pool is not
  healthy, or when an array disk is missing, disabled or has errors.
- **`disk-health`** (script, hourly): alerts when a disk's SMART data shows
  trouble: a failed health check, reallocated or unreadable sectors, an SSD
  near the end of its rated life, or a disk running too hot. A disk that is
  spun down is left asleep and skipped. The limits are at the top of the
  script; it is written in Python inside `check.sh`, as an example of that.
  `/run disk-health --report` shows every disk with the values the check
  judges, the sleeping disks it skipped and the limits, as an example of a
  task that takes an argument.
  An install from before 0.1.0-beta.8 does not get it by itself: ask Claude
  to copy it from `/usr/local/share/berthward/task-examples/disk-health`.
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
