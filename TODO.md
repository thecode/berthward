# TODO

Open work for this project. Delete an item once it's done. An item we decide not to do moves to **Dropped** at the end: kept so it can be picked up again, but not something that has to be finished.

## 1. Docs

- README and getting-started still mostly describe the upstream tool. Rewrite them for Berthward (the template overview is done), and link `docs/access.md` (the three ways in, login, the web terminal's settings) from both.
- In them, document the Discord setup (one bot per server, Message Content Intent, private bot needs Install Link = None, IDs via Developer Mode), the chat commands, the task format and the permission preset. Turn Autostart on after installing.
- The Discord section also says:
  - Discord's "Verify your App" page shows warnings (no Team, no Terms of Service or Privacy Policy link, no install link). None applies: verification is only for bots in more than 100 servers, and every Berthward user runs their own private bot in their own server. Do not add an install link; "None" is what keeps the bot private.
  - On the Bot page only Message Content Intent is needed; the permissions calculator there does nothing. Permissions are granted through the OAuth2 URL Generator (scope `bot`, the seven listed permissions, optionally Manage Messages so the bot can delete the `/code` message).
  - Turn on two-factor authentication for the Discord account: it is what approves commands, tasks and web sign-ins.
- Why there is a bridge: the official Discord channel plugin needs the channels research preview, which is off by default for Team and Enterprise accounts until an owner enables it, so the plugin silently receives nothing there.

## 2. For the owner: things to decide

Tried on a real server and working: the web terminal behind a real reverse proxy, `/login` with the automatic session restart, a first login on an empty data folder (the session leaves its welcome screen by itself), Discord-only mode, and password-only web sign-in.

To decide:

- Existing installs do not receive new allow-list entries (the settings merge leaves a user's allow list alone and only logs what is missing). Should the preset be offered more actively?

To do outside the code:

- The name is Berthward (checked against GitHub, Docker Hub, npm, PyPI, Steam, the App Store, the UK company register and common domains). Still open: a search of the official trademark registers (Classes 9 and 42) and Google Play, and registering a domain.
- An icon (`icon.png`), which the template already points at.

## 3. Before a public release

- Four releases are planned from one codebase: Unraid, TrueNAS, standalone Docker, and a Home Assistant app. Split what is Unraid-specific (the `host` helper's assumptions, the server scan, the allow list, the example tasks) into a platform profile.
- A last scan for private text, then the GitHub repository, image registry, Community Apps template and support thread. (The repository starts without the development history, so there is no older history to scan.)

## Dropped

Decided against for now. Nothing here needs doing; move an item back up to revive it.

- **Feed a message sent mid-job into the running job** instead of queueing it. It needs one long-lived Claude process per chat with messages streamed into it, which changes how every run, approval and `/stop` works. Queueing is predictable and `/stop` covers a change of mind. (Dropped 2026-11-21.)
- **Test a dropped connection to Discord.** The stand-in Discord would need the gateway's resume handshake. discord.js reconnects by itself and `claude-bridge` restarts the bridge if it exits, so this is the least valuable test left. (Dropped 2026-11-21.)
- **A pre-made login token as a template field** (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on another machine), so no interactive login is needed. `/login` on Discord covers the need; it was also never checked whether Remote Control accepts such a token. (Dropped 2026-11-21.)
- **Try an image attachment and an upload near the 8 MB limit on the real Discord.** Both directions work in the tests, and on a real server a file was sent and an image attachment was saved. What is left is how well Claude reads an image and the exact size limit, neither worth a separate check. (Dropped 2026-11-21.)
- **Test a login that expires in real use.** It cannot be forced; it will show up with time. The bridge already reports a missing login on Discord and `/login` renews it. Revive this if it fails when it happens. (Dropped 2026-11-21.)
- **Switch a conversation between Discord and the terminal.** The bot's first message and `/help` now say that the two are separate, which was the confusing part. A hand-off command (restart the interactive session on the Discord conversation, or the other way round) interrupts whatever the other side was doing, and Remote Control already puts the terminal's conversation on a phone. Typing Discord messages into the terminal session instead would lose the buttons, the queue and `/stop`. (Dropped 2026-11-21.)
