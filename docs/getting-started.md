# Getting Started

A step-by-step walk from an empty Docker tab to Claude answering you on
Discord. Read the [README](../README.md) first for what this is and what it
is not; this page only covers the how.

Everything below was done on Unraid 7.4.1. Other versions should behave the
same, but have not been watched doing so.

## 1. What you need

- Unraid 7.x with Docker enabled.
- An Anthropic account. A **claude.ai subscription** (Pro, Max, Team or
  Enterprise) gives you everything, including the Claude app. A Claude
  Console API key also works, but then there is no Remote Control.
- For Discord: a Discord account with two-factor authentication on, and a
  server you own. A private server with only you in it is fine.
- About half an hour the first time.
- The willingness to read what Claude proposes before you approve it. If you
  would not do the same work yourself on the command line, stop here.

Discord is optional but it is how most of Berthward is used: chat from your
phone, approval buttons, alerts from tasks, and login without a terminal.
Without it, skip step 2 and log in from the terminal in step 5.

## 2. Create your Discord bot

Follow [discord.md](discord.md) steps 1 to 3. You come back with three
things:

- the **bot token**,
- your **user ID**,
- a **channel ID**.

## 3. Install the container

Berthward is not in Community Applications yet. Until it is, build the image
on the server and add the template by hand: see
[Building and Testing Locally](../README.md#building-and-testing-locally).
Then Docker tab → **Add Container** → choose *berthward* under *User
templates*.

Once it is published: **Apps** → search for *berthward* → **Install**.

With a locally built image, Unraid's update check and **Force Update** have
nothing to pull; to update, pull the source again and rebuild the image, then
Apply the template once more.

Unraid stores the template on the flash drive, as it does for every
container. The bot token you enter is part of that template.

## 4. Fill in the template

Settings worth a look; leave everything else at its default:

| Field | What to do |
|---|---|
| **Data** and **Workspace** | Default is `/mnt/user/appdata/berthward/...`. If your appdata lives somewhere else (for example `/mnt/cache/appdata`), change both paths now. Pointing at a path under `/mnt/user` that does not exist makes Unraid create a new share |
| **Timezone** | Your timezone, e.g. `Europe/Berlin`. Task schedules use it |
| **Language** | Leave empty for English, or `de`, `fr`, ... for answers in that language |
| **Discord Bot Token** | The token from step 2 |
| **Discord Allowed Users** | Your user ID |
| **Discord Channels** | The channel ID |
| **Anthropic API Key** | Leave empty to log in with a claude.ai subscription (recommended) |
| **Unraid Boot Config** | Leave read-only for now |
| **Web Terminal** | Leave off for now; step 8 |

Do **not** enable Privileged. It is not needed; host commands run through a
helper container.

Click **Apply**. Wait until the Docker tab shows the container as started,
then click its icon → **Logs**. You should see:

```
CLAUDE.md generated at /workspace/CLAUDE.md
Berthward is running.
  Attach: docker exec -it berthward tmux attach -t main
  Remote: open the Claude app and look for 'berthward'
  Discord: bridge started (its own lines below start with 'bridge:')
  Login:  not logged in yet — send /login to the bot on Discord, or attach and complete the login once
bridge: connected as <your bot>; 1 allowed user(s), 1 channel(s)
```

In Discord the bot says hello in its channel and lists its commands.

The first start also downloads a small helper image (`alpine`) that host
commands run in. On a slow connection the log shows a warning about it and
the start takes longer.

**Turn Autostart on** for the container (the switch on the Docker tab), or it
will not come back after a server reboot.

## 5. Log in (once)

**From Discord:**

1. Send `/login` to the bot. If the command list has not appeared yet (it
   can take up to an hour after the bot first connects), write `!login`
   instead; every command also works with `!`.
2. Open the link it posts and sign in to your Anthropic account.
3. The page shows a code. Send it back with `/code` and paste the code as the
   command's value. Used this way the code never appears in the channel.
4. The bot confirms. The interactive session restarts by itself and is ready
   a few seconds later.

**From a terminal instead** (needed when you do not use Discord): Docker tab
→ container icon → **Console**. Claude Code shows its first-run setup: pick a
theme, choose the claude.ai subscription, press `c` to copy the login link
and open it on any device, paste the code back. In Unraid's Console the link
wraps over several lines and pasting can be unreliable; the web terminal
(step 8) avoids both. Without Discord the web terminal needs a **Web Terminal
Password** of 12 characters or more, and does not start without one.

If Claude Code asks whether to make **auto mode** its default, say no: this
container is set up to ask you before it acts.

The login is stored in the **Data** folder and survives restarts and updates.
If it ever expires, the bot says so and `/login` renews it.

## 6. First questions

Claude has already read the generated `CLAUDE.md` with your pools, shares,
containers, VMs and plugins. Write to the bot:

- *What do you know about this server?*
- *Which containers are not running, and why?*
- *How full are my pools, and what is taking the space?*

Read-only commands (`docker ps`, `logs <container>`, `host zpool status`,
...) run without asking. Anything else arrives as a **permission request**:
the exact command, with **Allow** and **Deny** buttons. That request is your
main safety control. Read it.

A few commands (formatting disks, `rm -rf` on a share root, writing to a
block device) are blocked by a guard hook even if you say yes; if you really
want one of those, do it yourself from the Unraid terminal. Some requests
carry an extra line starting with `claude-guard:` (for example *downloads
and runs code from the network*). That is the guard telling you why this
command deserves a second look. If a command like that came out of a
container log or a file Claude just read, be suspicious: that is exactly how
an attacker would try to use Claude.

`/help` lists the commands; [discord.md](discord.md#using-it) explains them.

## 7. Your first task

Two example tasks are waiting for your approval in the channel: a pool health
check every 15 minutes and a morning summary. Each request shows exactly what
the task contains. **Approve** the ones you want.

Then ask for your own:

> Every hour, check that the container `plex` is running, and tell me if not.

Claude writes it, and a minute later the bot asks you to approve it.
[tasks.md](tasks.md) explains the two kinds of task and how alerts behave.

## 8. The web terminal and the Claude app (optional)

Besides Discord there is one shared interactive session, the same Claude Code
you would see in a terminal. It suits longer work where you want to watch
each step.

- **Web terminal:** container → **Edit** → set **Web Terminal** to `true` and
  **Web Terminal Port** to `7682` → Apply. The container's **WebUI** button
  opens it. Each sign-in is approved on Discord: the page shows a short code,
  the bot shows the same code with where the request comes from, and you
  click Allow.
- **Claude app:** open the Claude app, tap **Code**; the session is listed
  under the name `berthward` with a green dot while online (set **Remote
  Control Name** to tell several servers apart). The same list is
  at [claude.ai/code](https://claude.ai/code). It needs a claude.ai
  subscription login. The first time, Claude Code may ask in the terminal to
  enable Remote Control; confirm it.
- **Console:** Docker tab → container icon → **Console**.

What you discussed on Discord is not in that session, and the other way
round; files under `/workspace` are shared. [access.md](access.md) has the
details, including a password instead of Discord approval, running behind a
reverse proxy, and how long a browser stays signed in.

**Leaving the terminal without stopping Claude:** press `Ctrl-b`, release,
then `d`, or just close the window. Do not type `/exit` in Claude unless you
mean it; Claude would quit and be restarted a few seconds later.

## 9. Give Claude more access (optional, later)

By default Claude sees the flash drive read-only and no shares. To extend
that: Docker tab → container → **Edit**:

- **Unraid Boot Config** → change `Read Only` to `Read/Write` to let Claude
  install plugins or edit templates. While it is read-only, the flash drive
  is read-only for Claude everywhere, host commands included; a write simply
  fails, and Claude is told to send you here instead of looking for a way
  around. Once read-write, commands that touch the flash drive ask you first,
  with a reason.
- **Container App Data** (advanced view) → set to your appdata path,
  read-only, so Claude can inspect other containers' configs.
- **Any share** → *Add another Path* at the bottom of the edit page: Host
  path `/mnt/user/<share>`, Container path `/<share>` (any name you like,
  outside `/root`), Access Mode read-only unless Claude should change files.
  You do not have to plan this ahead: Claude sees the names of all your
  shares and will tell you these steps when a question needs one of them.

**Apply** restarts the container; `CLAUDE.md` is regenerated and now lists
the new paths.

**Your own rules** go under `## Custom` at the end of
`/workspace/CLAUDE.md`: scripts Claude must never run, how your backups work,
which containers matter most. That section survives restarts. After editing
it, send `/new` so the next Discord conversation reads it.

## 10. Updating, stopping, removing

- **Update:** Docker tab → container → **Force Update** when a new image is
  out. Your login, settings, tasks and history live in the two data folders
  and are kept. New default settings are merged in underneath yours (your
  values win; a `settings.json.bak` is left next to the file). If the update
  lets Claude do something new without asking, the bot tells you what.
- **Stop/Start:** as any container. `CLAUDE.md` is rebuilt on every start,
  the last conversations are resumed, approved tasks stay approved. While it
  is stopped, no task runs and nothing alerts.
- **Remove:** remove the container, then delete the two data folders. The
  flash drive only holds the template Unraid saved when you installed it,
  plus the `berthward` lines in `/boot/config/go` if you added the host
  command. Delete the bot in the Discord Developer Portal, or at least reset its
  token.

## 11. If something looks wrong

- **The bot does not answer:** [discord.md](discord.md#if-something-does-not-work).
- **The web terminal:** [access.md](access.md#if-something-does-not-work).
- `CLAUDE.md` says `Host scan failed`: the helper image could not be pulled
  or the scan could not run. Check internet access, restart the container.
- `Claude exited ... Restarting in 5 s` keeps repeating in the terminal: read
  the message above it; after five quick exits the wrapper stops and leaves
  the output on screen.
- Health shows *unhealthy*: the interactive session or the bridge is gone.
  Restart the container; if it repeats, open an issue with the log.
- Anything else: [issues](https://github.com/thecode/berthward/issues), with
  the container log and the `## Detected Environment` part of your
  `CLAUDE.md`. Check both for anything you do not want to share first, and
  never post the bot token.
