#!/bin/bash
set -euo pipefail

# Switches that exist for the tests (they redirect the bridge's calls to
# Discord, its folders, and what the scan and the guard read). They have no
# place in a running container: whatever the container was started with, they
# end here, before anything reads them.
unset BRIDGE_DISCORD_API BRIDGE_STATE_DIR BRIDGE_WORKDIR BRIDGE_TASKS_DIR MOUNTINFO CLAUDE_MD_DEST CLAUDE_MD_SHARE DOCKER_SOCK USERSCRIPTS_SCHEDULE

SESSION="${TMUX_SESSION:-main}"
RC_NAME="${REMOTE_CONTROL_NAME:-$(hostname)}"
CONTINUE="${CONTINUE:-true}"
export HOST_HELPER_IMAGE="${HOST_HELPER_IMAGE:-alpine:3.21}"

# ── Seed dotfiles into the persisted home on first run ───────────────────────
[ -f /root/.tmux.conf ] || cp /usr/local/share/berthward/tmux.conf /root/.tmux.conf

# Seed default settings (manual permission mode, read-only allow list, deny
# list, guard hook). First run: copy. Later runs: keep the user's file; when
# the shipped settings gained keys since the install was last brought up to
# date (version stamp), merge them underneath the user's keys once. A key the
# user removes afterwards stays removed. Allow entries that are new since the
# install's stamp are added, and the user is told which (log, and Discord).
SETTINGS_DEFAULT=/usr/local/share/berthward/settings.json
SETTINGS=/root/.claude/settings.json
SETTINGS_STAMP=/root/.claude/.berthward-settings-version
ALLOW_VERSIONS=/usr/local/share/berthward/allow-versions.json
# An install that came from claude-unraid-manager, which this is based on,
# keeps its stamp.
OLD_STAMP=/root/.claude/.claude-unraid-manager-settings-version
if [ -f "$OLD_STAMP" ] && [ ! -f "$SETTINGS_STAMP" ]; then mv "$OLD_STAMP" "$SETTINGS_STAMP"; fi
SETTINGS_VERSION=8   # bump whenever settings.json gains keys existing installs should receive
mkdir -p /root/.claude
stamp=$(cat "$SETTINGS_STAMP" 2>/dev/null || true)
case "$stamp" in ''|*[!0-9]*) stamp=0 ;; esac
if [ ! -f "$SETTINGS" ]; then
  cp "$SETTINGS_DEFAULT" "$SETTINGS"
  echo "$SETTINGS_VERSION" > "$SETTINGS_STAMP"
elif [ "$stamp" -lt "$SETTINGS_VERSION" ]; then
  added=$(claude-settings-merge --new-allow "$SETTINGS_DEFAULT" "$SETTINGS" "$ALLOW_VERSIONS" "$stamp" 2>/dev/null || true)
  if claude-settings-merge "$SETTINGS_DEFAULT" "$SETTINGS" "$ALLOW_VERSIONS" "$stamp" > "$SETTINGS.merged" 2>/dev/null; then
    cp "$SETTINGS" "$SETTINGS.bak"
    mv "$SETTINGS.merged" "$SETTINGS"
    echo "$SETTINGS_VERSION" > "$SETTINGS_STAMP"
    echo "settings.json: merged in the shipped defaults (guard hook, permission mode, deny and ask lists) underneath your settings (backup: settings.json.bak)."
    if [ -n "$added" ]; then
      echo "settings.json: new in this version, Claude may now do these without asking: $(printf '%s' "$added" | tr '\n' ' ')"
      # The bridge posts this once on Discord and then removes the file.
      mkdir -p /root/.claude/bridge
      printf '%s\n' "$added" >> /root/.claude/bridge/allow-added
    fi
    missing=$(claude-settings-merge --missing-allow "$SETTINGS_DEFAULT" "$SETTINGS" 2>/dev/null | tr '\n' ' ')
    [ -z "$missing" ] || echo "settings.json: shipped entries your allow list does not have (removed earlier, left that way): $missing"
  else
    rm -f "$SETTINGS.merged"
    echo "Warning: settings.json is not valid JSON; the shipped defaults (guard hook, permission mode) were not merged in."
  fi
fi

# Fix SSH key permissions (bind-mount may loosen them)
if [ -d /root/.ssh ]; then
  chmod 700 /root/.ssh 2>/dev/null || true
  find /root/.ssh -type f -name 'id_*' ! -name '*.pub' -exec chmod 600 {} + 2>/dev/null || true
  chmod 644 /root/.ssh/*.pub 2>/dev/null || true
  chmod 600 /root/.ssh/config /root/.ssh/known_hosts 2>/dev/null || true
fi

# ── Make sure the host helper image is available ─────────────────────────────
# `host` (and the scan below) start a tiny helper container; pull it now so
# the first host command does not stall or fail on a cold cache.
if [ -S /var/run/docker.sock ]; then
  if ! docker image inspect "$HOST_HELPER_IMAGE" >/dev/null 2>&1; then
    timeout 60 docker pull -q "$HOST_HELPER_IMAGE" >/dev/null 2>&1 \
      || echo "Warning: could not pull $HOST_HELPER_IMAGE within 60 s — the first host command will pull it instead."
  fi
fi

# ── Seed the example monitoring tasks on first run ───────────────────────────
# Only when there is no tasks folder yet, so deleted examples stay deleted.
# A task does not run until its content is approved on Discord.
if [ ! -d /workspace/tasks ]; then
  mkdir -p /workspace/tasks
  cp -r /usr/local/share/berthward/task-examples/. /workspace/tasks/
fi

# ── Generate / refresh CLAUDE.md ─────────────────────────────────────────────
/usr/local/bin/generate-claude-md.sh

# ── Build the claude launch arguments ────────────────────────────────────────
ARGS=()
[ "$CONTINUE" = "true" ] && ARGS+=(--continue)
# Remote Control needs a claude.ai login; with an API key it cannot start.
# REMOTE_CONTROL_NAME=off disables it explicitly.
REMOTE_CONTROL=false
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY is set: Remote Control disabled (requires a claude.ai login)."
elif [ -n "$RC_NAME" ] && [ "$RC_NAME" != "off" ]; then
  ARGS+=(--remote-control "$RC_NAME")
  REMOTE_CONTROL=true
fi

# ── Discord bridge (optional) ────────────────────────────────────────────────
# With a bot token and an allowlist, the bridge runs in the background next to
# the interactive session: messages from Discord start headless Claude runs,
# and their permission prompts are answered with buttons on Discord. The token
# is dropped from the environment afterwards, so the interactive session and
# the commands it runs do not inherit it. It cannot be taken out of the
# container altogether: it is part of the container's configuration, so it
# stays in the template on the flash drive, in `docker inspect`, in /proc of
# the first processes and in the environment of anything `docker exec` starts.
# Reading any of those asks the user first (settings.json, claude-guard).
DISCORD=off
BRIDGE_PID=
WEB_PID=
if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
  if [ -z "${DISCORD_ALLOWED_USERS:-}" ]; then
    echo "Discord: a bot token is set but Discord Allowed Users is empty; the bridge is not started."
    DISCORD=failed
  else
    claude-bridge &
    BRIDGE_PID=$!
    DISCORD=on
  fi
fi
unset DISCORD_BOT_TOKEN

# ── Interactive session (optional) ───────────────────────────────────────────
# INTERACTIVE_SESSION=false runs the Discord bridge only: no tmux, no Remote
# Control, no web terminal. Log in from Discord with /login in that mode.
INTERACTIVE=$(printf '%s' "${INTERACTIVE_SESSION:-true}" | tr '[:upper:]' '[:lower:]')
case "$INTERACTIVE" in false|0|no|off) INTERACTIVE=false ;; *) INTERACTIVE=true ;; esac
if [ "$INTERACTIVE" = false ]; then
  REMOTE_CONTROL=false
  if [ "$DISCORD" != on ]; then
    echo "Nothing to run: the interactive session is off and the Discord bridge is not started. Set a Discord bot token and allowed users, or turn the interactive session back on."
  fi
fi

# ── Web terminal without Discord ─────────────────────────────────────────────
# With the bridge, the web terminal is part of it and sign-ins are approved on
# Discord. Without it, a long password is the only way in (see web-only.ts).
WEB=off
case "$(printf '%s' "${WEB_TERMINAL:-false}" | tr '[:upper:]' '[:lower:]')" in true|1|yes)
  if [ "$DISCORD" = on ]; then
    WEB=bridge
  elif [ "$INTERACTIVE" = false ]; then
    echo "Web terminal: not started, the interactive session is off."
  elif [ -z "${WEB_PASSWORD:-}" ]; then
    echo "Web terminal: not started. Without the Discord bridge it needs a Web Terminal Password (12 characters or more)."
  else
    claude-bridge web-only &
    WEB_PID=$!
    WEB=password
  fi ;;
esac
unset WEB_PASSWORD

# What the health check should find running (see claude-health).
mkdir -p /run/berthward
: > /run/berthward/expect
[ "$INTERACTIVE" = false ] || echo session >> /run/berthward/expect
[ "$DISCORD" != on ] || echo bridge >> /run/berthward/expect
[ "$WEB" != password ] || echo web >> /run/berthward/expect

if [ "$INTERACTIVE" = true ]; then
# ── Start tmux with Claude inside ────────────────────────────────────────────
# "=" makes tmux match the session name exactly instead of by prefix. For
# pane targets (send-keys) the session must end with ":" or tmux reads the
# whole string as a pane name.
if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c /workspace
  # Small delay so tmux is fully ready before sending keys
  sleep 0.3
  # claude-session restarts claude if it exits; %q keeps names with spaces intact.
  tmux send-keys -t "=$SESSION:" "clear; $(printf '%q ' claude-session "${ARGS[@]}")" C-m
fi
fi

echo "Berthward is running."
if [ "$INTERACTIVE" = true ]; then
  # The container's name as the host knows it (Unraid passes it in); the
  # hostname is the fallback and is often the same.
  echo "  Attach: docker exec -it ${HOST_CONTAINERNAME:-$(hostname)} tmux attach -t $SESSION"
else
  echo "  Session: off (Discord bridge only)"
fi
if [ "$REMOTE_CONTROL" = true ]; then
  echo "  Remote: open the Claude app and look for '$RC_NAME'"
else
  echo "  Remote: Remote Control is disabled"
fi
case "$DISCORD" in
  on)     echo "  Discord: bridge started (its own lines below start with 'bridge:')" ;;
  failed) echo "  Discord: not started, see the message above" ;;
  *)      echo "  Discord: off (no bot token set)" ;;
esac
# A claude.ai login leaves .credentials.json and an oauthAccount entry in .claude.json.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f /root/.claude/.credentials.json ] \
   && ! grep -qs oauthAccount /root/.claude.json; then
  if [ "$DISCORD" = on ]; then
    echo "  Login:  not logged in yet — send /login to the bot on Discord, or attach and complete the login once"
  else
    echo "  Login:  not logged in yet — attach and complete the login once"
  fi
fi

# Keep the container alive without burning CPU. On stop, end the tmux server
# first so Claude shuts down cleanly instead of being killed with the container.
shutdown() {
  [ -z "$BRIDGE_PID" ] || kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  [ -z "$WEB_PID" ] || kill -TERM "$WEB_PID" 2>/dev/null || true
  tmux kill-server 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT
tail -f /dev/null &
wait $!
