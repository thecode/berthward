# TODO

Open work for this project. Delete an item once it's done. An item we decide not to do moves to **Dropped** at the end: kept so it can be picked up again, but not something that has to be finished.

## 1. Before a public release

- Four releases are planned from one codebase: Unraid, TrueNAS, standalone Docker, and a Home Assistant app. Split what is Unraid-specific (the `host` helper's assumptions, the server scan, the allow list, the example tasks) into a platform profile. Packaging files already live per platform under `platforms/` (so far `platforms/unraid/template.xml`); the profiles and the other platforms' packaging go next to it.
- Publishing. Done: the GitHub repository exists (private), and the image `ghcr.io/thecode/berthward` is published as `0.1.0-beta.1` and `beta` (package private). That image was pulled and run on a real server from the Unraid template. Still to do, in order:
  - Make the repository and the package public. A public package cannot be made private again, only deleted.
  - Protect `main`: no force pushes or deletion, and require the `test` and `build` checks.
  - Community Apps template and support thread.

## 2. Noted in the pre-release review, not done

None of these blocks a release. Each needs control of the container or its network, or is small.

- The web terminal checks that a request's Origin matches its Host, but has no list of allowed host names, so a DNS-rebinding page passes that check. It still needs the owner's Allow or the password.
- A web sign-in that nobody answers is shown in the browser as denied; the page has a separate "not answered in time" text that is never used.
- `CLAUDE.md` is built from names on the host (containers, VMs, shares, User Script names and descriptions) without escaping. Whoever can set those writes into the file Claude treats as rules.
- The bridge's local endpoints (127.0.0.1, random port) take requests from any process in the container.
- The bot token and web password are removed from the environment Claude inherits, but stay readable for root in `/proc` of the container's first processes.
- Base images in the Dockerfile are pinned by tag, not by digest.

## Settled, for the record

- Tried on a real server and working: the web terminal behind a real reverse proxy, `/login` with the automatic session restart, a first login on an empty data folder (the session leaves its welcome screen by itself), Discord-only mode, and password-only web sign-in.

- Changes go in through pull requests, each with one label (`bugfix`, `new-feature`, `enhancement`, `documentation`, `ci`, `dependencies` and so on; a check refuses a pull request without one). Every merge updates a draft release whose notes are sorted by those labels. Publishing the draft creates the version tag, and the tag builds and publishes the image. While `prerelease-identifier: "beta"` is set in `.github/release-drafter.yml`, each draft is the next `-beta.N`; such a tag also moves the `beta` image tag that the template names.

- The name is Berthward. It was checked against trademark registers, app stores, package registries and the web before it was chosen.

## Dropped

Decided against for now. Nothing here needs doing; move an item back up to revive it.

- **Feed a message sent mid-job into the running job** instead of queueing it. It needs one long-lived Claude process per chat with messages streamed into it, which changes how every run, approval and `/stop` works. Queueing is predictable and `/stop` covers a change of mind. (Dropped 2026-11-21.)
- **Test a dropped connection to Discord.** The stand-in Discord would need the gateway's resume handshake. discord.js reconnects by itself and `claude-bridge` restarts the bridge if it exits, so this is the least valuable test left. (Dropped 2026-11-21.)
- **A pre-made login token as a template field** (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on another machine), so no interactive login is needed. `/login` on Discord covers the need; it was also never checked whether Remote Control accepts such a token. (Dropped 2026-11-21.)
- **Try an image attachment and an upload near the 8 MB limit on the real Discord.** Both directions work in the tests, and on a real server a file was sent and an image attachment was saved. What is left is how well Claude reads an image and the exact size limit, neither worth a separate check. (Dropped 2026-11-21.)
- **Test a login that expires in real use.** It cannot be forced; it will show up with time. The bridge already reports a missing login on Discord and `/login` renews it. Revive this if it fails when it happens. (Dropped 2026-11-21.)
- **Switch a conversation between Discord and the terminal.** The bot's first message and `/help` now say that the two are separate, which was the confusing part. A hand-off command (restart the interactive session on the Discord conversation, or the other way round) interrupts whatever the other side was doing, and Remote Control already puts the terminal's conversation on a phone. Typing Discord messages into the terminal session instead would lose the buttons, the queue and `/stop`. (Dropped 2026-11-21.)
