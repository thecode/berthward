# Discord

How to create the bot, what to put in the template, and how to use it.

You need a Discord account and a server (a "guild") that you own. A private
server with only you in it is fine and takes a minute to create: the **+** at
the bottom of the server list → *Create My Own* → *For me and my friends*.

## Before you start

- **One bot per server.** A bot token can be connected from one place at a
  time. Two Berthward containers sharing a token would both answer. Create a
  separate application for each server and name it after the server.
- **Turn on two-factor authentication** for your Discord account (User
  Settings → My Account). Your account is what approves commands, tasks and
  web terminal sign-ins, so it deserves the same care as the server's root
  password.

## 1. Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Name it after your server.
2. **Installation** page: set **Install Link** to **None**. A private bot
   cannot have an install link, and Discord refuses to save the next step
   with one.
3. **Bot** page:
   - **Public Bot:** off.
   - **Message Content Intent:** on (under *Privileged Gateway Intents*).
     Without it the bot connects but cannot read what you write. Leave
     *Presence Intent* and *Server Members Intent* off.
   - **Reset Token**, and copy the token. It is shown once. It goes into the
     template, nowhere else: not into a chat, not into a file you share.

The permissions calculator at the bottom of the Bot page does nothing here;
permissions are granted in the next step.

## 2. Add the bot to your server

**OAuth2** page → **URL Generator**:

1. Under *Scopes* tick **bot**.
2. Under *Bot Permissions* tick these seven:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Read Message History
   - Attach Files
   - Add Reactions
3. Optional: **Manage Messages**. With it the bot deletes a login code you
   typed as a plain message. It is not needed if you use `/code`, which never
   shows the code in the channel.
4. Leave *Integration Type* on **Guild Install**, copy the generated URL,
   open it, pick your server and authorize.

## 3. Collect the IDs

Turn on **Developer Mode** (User Settings → Advanced). Then:

- **Your user ID:** right-click your own name → *Copy User ID*.
- **A channel ID:** right-click the channel the bot should use → *Copy
  Channel ID*. A channel of its own, named after the server, keeps things
  tidy.

Both are long numbers. They are not secrets, but the token is.

## 4. Fill in the template

| Field | Value |
|---|---|
| **Discord Bot Token** | The token from step 1 |
| **Discord Allowed Users** | Your user ID. Several people: comma-separated |
| **Discord Channels** | The channel ID. Empty = the bot only answers direct messages |
| **Discord Alert Channel** | Leave empty to use the same channel for alerts |

Apply. The container log should say `bridge: connected as <name>`, and the
bot says hello in the channel the first time it connects.

If the log says *Used disallowed intents*, Message Content Intent is off
(step 1). If it says the token is invalid, reset the token and paste the new
one.

## Discord's "Verify your App" page

The Developer Portal shows a page with warnings: no team, no Terms of Service
or Privacy Policy link, no install link. None of it applies. Verification is
for bots that are in more than 100 servers; yours is in one. Do not add an
install link to make the warning go away: "None" is what keeps the bot
private.

## Using it

Write to the bot in its channel like you would to a person. Messages you send
while it is working are queued and marked with a clock.

| Command | What it does |
|---|---|
| `/new` | Start a fresh conversation (Claude forgets this chat) |
| `/stop` | Cancel the job that is running and drop your queued messages |
| `/status` | What the bridge is doing |
| `/tasks` | List the scheduled tasks |
| `/run <name>` | Run one task now |
| `/login` | Sign Claude in to your Anthropic account; `/login cancel` stops a login that is waiting |
| `/code <code>` | Send the code from the sign-in page |
| `/restart-session` | Restart the interactive session |
| `/help` | Show this list |

Type `/` to pick a command from the list. Every command also works written
with `!` (`!status`), which helps on clients where the slash list is slow to
appear. Slash commands can take up to an hour to show up after the bot first
connects; that is Discord, not the bot.

**Permission requests.** When Claude wants to do something that needs your
approval, the bot posts the exact command or file with **Allow** and **Deny**
buttons. Only the allowed users can press them. No answer within ten minutes
counts as a deny. Read the request: it is the main safety control.

**Conversations.** The bot keeps one conversation per channel until you send
`/new`. That conversation is separate from the one in the terminal, the web
terminal and the Claude app; files under `/workspace` are shared by both. A
conversation keeps the rules it started with, so after editing `CLAUDE.md`
send `/new`.

**Files** in both directions, and the limits on jobs:
[access.md](access.md#files-over-discord).

**Tasks:** [tasks.md](tasks.md).

## If something does not work

| What you see | What to check |
|---|---|
| The bot is online but ignores you | Your user ID is not in **Discord Allowed Users**, or the channel is not in **Discord Channels** |
| The bot answers in direct messages only | **Discord Channels** is empty |
| No slash commands in the list | Wait up to an hour after the first start, or use `!help` |
| "Claude is not logged in" | Send `/login` |
| The bot went offline | Look at the container log for lines starting with `bridge:`. The bridge reconnects by itself and is restarted if it stops |
