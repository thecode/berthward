# TODO

Open work for this project. Delete an item once it's done. An item we decide not to do moves to **Dropped** at the end: kept so it can be picked up again, but not something that has to be finished.

## 1. Open

- **Community Applications listing.** The template was pushed to `thecode/unraid-docker-templates` on 2026-11-22; the listing itself has not been seen yet. Once *berthward* shows up under Apps, change the README and `docs/getting-started.md`, which still say the entry does not exist and describe the install by hand first. If it does not show up, Apps → Statistics → Template Errors or Invalid Templates says why.
- **Other platforms.** Four releases are planned from one codebase: Unraid (out), TrueNAS, standalone Docker, and a Home Assistant app. Split what is Unraid-specific (the `host` helper's assumptions, the server scan, the allow list, the example tasks) into a platform profile. Packaging files already live per platform under `platforms/` (so far `platforms/unraid/template.xml`); the profiles and the other platforms' packaging go next to it.
- **Dependabot: Node 22 to 26** for the build stage that fetches Claude Code. A major jump: check that the Claude Code package installs and runs its post-install step on it before merging.
- **A forum support thread** (optional). The template's support link goes to the GitHub issues; if a thread is opened, point `Support` at it.

## Settled, for the record

- Tried on a real server and working: the web terminal behind a real reverse proxy, `/login` with the automatic session restart, a first login on an empty data folder (the session leaves its welcome screen by itself), Discord-only mode, and password-only web sign-in.

- Changes go in through pull requests, each with one label (`bugfix`, `new-feature`, `enhancement`, `documentation`, `ci`, `dependencies` and so on; a check refuses a pull request without one). Every merge updates a draft release whose notes are sorted by those labels. Publishing the draft creates the version tag, and the tag builds and publishes the image. While `prerelease-identifier: "beta"` is set in `.github/release-drafter.yml`, each draft is the next `-beta.N`; such a tag also moves the `beta` image tag that the template names.

- Published on 2026-11-22: the repository and the image `ghcr.io/thecode/berthward` are public, `v0.1.0-beta.2` is the current release, and `beta` is the tag the template installs. A public package cannot be made private again, only deleted.

- `main` is protected by a ruleset: no deletion, no force pushes, changes only through a pull request (no approval needed), and the `test` and `build` checks must pass.

- The Unraid template has two homes. `platforms/unraid/template.xml` here is the source; Community Applications reads the copy in `thecode/unraid-docker-templates` (`templates/berthward.xml`). After changing the template, copy it there unchanged. That repository must never be renamed or moved: Community Applications blacklists a template repository that changes its address.

- The repository was created anew on 2026-11-22, so pull request numbers restart at 1 and the "Merge pull request #N" lines of older commits do not match the pull request pages. The notes of `v0.1.0-beta.2` were written by hand for the same reason; from the next release on the drafter writes them.

- The six notes from the pre-release review are done. What each one leaves, by design:
  - Web terminal host names: with **Web Terminal Host Names** set, any other host name is refused. It is off by default so that existing set-ups keep working; without it a sign-in request under a public name is marked on Discord.
  - An unanswered web sign-in now says "not answered in time" in the browser.
  - `CLAUDE.md`: names from the host can no longer change the file's structure (no control characters, backticks or angle brackets), and the generated section says they are data. What a name says cannot be filtered; the note is the defence.
  - The bridge's local endpoints need the token of the run being answered and act on that run's chat only. Root in the container can read a running job's environment, so this narrows who can ask; it is not a boundary.
  - The bot token and web password are part of the container's configuration, so they cannot be taken out of `/proc` (anything `docker exec` starts gets them again). Reading a process environment now asks first, like `docker inspect` and the saved template already did.
  - Base images are pinned by tag and digest, and Dependabot proposes their updates.

- The name is Berthward. It was checked against trademark registers, app stores, package registries and the web before it was chosen.

## Dropped

Decided against for now. Nothing here needs doing; move an item back up to revive it.

- **Feed a message sent mid-job into the running job** instead of queueing it. It needs one long-lived Claude process per chat with messages streamed into it, which changes how every run, approval and `/stop` works. Queueing is predictable and `/stop` covers a change of mind. (Dropped 2026-11-21.)
- **Test a dropped connection to Discord.** The stand-in Discord would need the gateway's resume handshake. discord.js reconnects by itself and `claude-bridge` restarts the bridge if it exits, so this is the least valuable test left. (Dropped 2026-11-21.)
- **A pre-made login token as a template field** (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on another machine), so no interactive login is needed. `/login` on Discord covers the need; it was also never checked whether Remote Control accepts such a token. (Dropped 2026-11-21.)
- **Try an image attachment and an upload near the 8 MB limit on the real Discord.** Both directions work in the tests, and on a real server a file was sent and an image attachment was saved. What is left is how well Claude reads an image and the exact size limit, neither worth a separate check. (Dropped 2026-11-21.)
- **Test a login that expires in real use.** It cannot be forced; it will show up with time. The bridge already reports a missing login on Discord and `/login` renews it. Revive this if it fails when it happens. (Dropped 2026-11-21.)
- **Switch a conversation between Discord and the terminal.** The bot's first message and `/help` now say that the two are separate, which was the confusing part. A hand-off command (restart the interactive session on the Discord conversation, or the other way round) interrupts whatever the other side was doing, and Remote Control already puts the terminal's conversation on a phone. Typing Discord messages into the terminal session instead would lose the buttons, the queue and `/stop`. (Dropped 2026-11-21.)
