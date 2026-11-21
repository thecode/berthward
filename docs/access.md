# Ways in: Discord, web terminal, Claude app

Berthward gives you three ways to reach Claude on your server. They can be used side by side.

| | Discord | Web terminal | Claude app |
|---|---|---|---|
| What it is | Chat with your own bot | The Claude session in a browser tab | The same session in Anthropic's app |
| Best for | Quick questions, alerts, approving from your phone | Longer work where you want to see each step | The same, away from your network |
| Needs | A Discord bot | A published port; Discord or a password | A claude.ai login (not an API key) |
| Approvals | Allow / Deny buttons | Prompts in the terminal | Prompts in the app |

Discord has its own conversation. The web terminal and the Claude app show one shared session, the "interactive session". What you discussed on Discord is not in that session and the other way round; files under `/workspace` (tasks, notes) are shared by both. The bot's first message and `/help` say so too. A Discord conversation does not appear in Claude Code's `/resume` list in the terminal.

## Jobs on Discord

- One job runs at a time per bot. Messages you send meanwhile are queued and marked with a clock; `/stop` ends the running job and drops your queued messages.
- A job is stopped after 60 minutes and you are told. Change this with **Discord Job Time Limit (minutes)**; `0` means no limit.
- A permission request that is not answered within 10 minutes counts as denied.

## Files over Discord

- **Sending Claude a file:** attach it to your message (a screenshot, a log, a config file). It is saved in Claude's own folder under `/workspace/inbox/`, and Claude is told where. Up to 10 files per message, 25 MB each; inbox files are deleted after 7 days. Saving is all that happens: nothing opens or runs the file. If you ask Claude to run a script you sent, that is a command like any other and you get the Allow / Deny request first.
- **Getting a file from Claude:** ask for it ("send me the last 500 lines of the syslog as a file"). Claude can only send regular files from inside `/workspace`, up to 8 MB (Discord's limit for a bot in a server without boosts). A file from anywhere else has to be copied there first, which needs your approval.
- A file you forward from someone else may contain text written to mislead an AI. Claude is told to treat file contents as material, not instructions, and anything risky still asks you first.

The limits can be changed with the container variables `BRIDGE_ATTACH_MAX_MB`, `BRIDGE_SEND_MAX_MB` and `BRIDGE_INBOX_DAYS`.

## Logging Claude in

Claude needs to be signed in to your Anthropic account once. The login is stored in the data folder and survives restarts and updates.

- **From Discord:** send `/login` to your bot. It posts a link; open it, sign in, and send the code the page shows back as `/code <code>`. The interactive session restarts by itself and is ready a few seconds later.
- **From a terminal:** open the container's Console in Unraid, or the web terminal, and follow the prompt. In Unraid's Console the link wraps over several lines and pasting is unreliable; `/login` or the web terminal avoids both.

If a login expires, Claude says so on Discord and `/login` renews it. `/restart-session` restarts the interactive session if it still shows a login screen.

## The web terminal

Turn it on with **Web Terminal** = `true` and set **Web Terminal Port** (for example `7682`). The container's WebUI button then opens it.

### Signing in

- **With the Discord bridge (recommended):** the page sends a sign-in request to Discord showing the browser's address, its name on your network, the browser, and a four-character code that the page shows too. Click **Allow** only if you just opened the page yourself and the code matches. No answer within two minutes counts as a deny. A **Web Terminal Password** is optional here; if set, it is asked before the request goes to Discord.
- **Without Discord:** set a **Web Terminal Password** of at least 12 characters. That password is then the only protection in front of a session with root-level access to your server, so make it long and unique. Five wrong tries lock an address out for 15 minutes, and every sign-in is written to the container log.

### How long you stay signed in

**Web Terminal Stay Signed In (hours)**:

- `0`: never stay signed in. The sign-in ends about two minutes after the page is closed, and each visit needs a new sign-in.
- any other number: hours, at most 168 (one week). The default is 12.

A container restart or update signs every browser out. **Sign out** on the page ends that sign-in everywhere it is open.

### Good to know

- **Plain HTTP.** Like Unraid's own web UI by default, the page is not encrypted. Use it on a network you trust, or put it behind a reverse proxy that adds TLS.
- **Behind a reverse proxy:** set **Web Terminal Behind Proxy** = `true` so the sign-in request shows the visitor's real address instead of the proxy's, and the cookie is marked secure over https. Only do this when nothing but the proxy can reach the port: with it on, the page believes the `X-Forwarded-*` headers, which any direct client could fake. In practice pick one: leave it off and use the LAN address, or turn it on and stop publishing the port to the LAN (put the container on the proxy's Docker network and clear **Web Terminal Port**). If a second proxy or CDN sits in front of yours, the request shows that outer proxy's address; only the nearest proxy is trusted.
- **Location lookup:** **Web Terminal Location Lookup** = `true` adds an approximate city and country to the sign-in request for public addresses. To do that the address is sent to an outside service (ipapi.co) on each sign-in attempt. Addresses on your own network are never sent. Off by default.
- **One shared screen.** Every browser, and the Claude app, sees the same session. Two people typing at once type into the same prompt. That suits a single owner; it is not a multi-user system.
- **Opening it from two names** (for example `server.lan` and the IP address) needs a sign-in for each: a browser treats them as different sites.

## Discord-only mode

**Interactive Session** = `false` runs only the Discord bridge: no interactive session, no web terminal, no Claude app access. Log in with `/login`. The container then reports itself healthy when the bridge is running.

## If something does not work

| What you see | What to check |
|---|---|
| Claude on Discord ignores a rule you just added to `CLAUDE.md` | A conversation keeps the rules it started with; send `/new` to start one that reads the current rules |
| Web terminal says "no interactive session is running" | The session ended; send `/restart-session` |
| The web terminal page does not open at all | **Web Terminal** is not `true`, or **Interactive Session** is `false` (the log then says "not started, the interactive session is off") |
| Sign-in page asks again on every visit | **Stay Signed In** is `0`, a private browser window, or a different host name than the one you signed in at |
| No request arrives on Discord | The bridge is not connected; look for lines starting with `bridge:` in the container log |
| "Too many wrong passwords from this address" | Wait 15 minutes, or restart the container to clear the lock |
| Container log: "Web terminal: not started" | Without Discord a password of 12 characters or more is required |
