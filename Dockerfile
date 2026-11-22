# Every base image is pinned by tag and digest: the tag says which version it
# is, the digest makes the build use exactly that image even if the tag is
# moved. Dependabot proposes updates to both (see .github/dependabot.yml).

# Bun runs the Discord bridge. Only the one binary and the bridge's
# dependencies are carried into the runtime image.
FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643 AS bun
WORKDIR /bridge
COPY bridge/package.json bridge/bun.lock ./
RUN bun install --frozen-lockfile --production

# ── build: fetch the Claude Code native binary via npm ───────────────────────
# The npm package's postinstall copies the platform binary over bin/claude.exe;
# `claude` then execs it directly and no Node.js process stays resident. Only
# that one file is carried into the runtime image.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build

# Pin the Claude Code version so every image is reproducible.
# Bump this (and rebuild) to update Claude Code.
ARG CLAUDE_CODE_VERSION=2.1.296

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && cp -L "$(readlink -f /usr/local/bin/claude)" /claude \
    && chmod 0755 /claude \
    && /claude --version

# ── Docker CLI ───────────────────────────────────────────────────────────────
# A stage of its own so that the image it comes from is pinned and updated
# like the others. Only the client binary is copied out of it.
FROM docker:29-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS dockercli

# ── runtime ──────────────────────────────────────────────────────────────────
# No Node.js in the runtime image: Claude Code runs natively. MCP servers that
# are started through `npx` therefore do not work inside this container; Bun is
# present for the Discord bridge.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS runtime

COPY --from=build /claude /usr/local/bin/claude
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /bridge/node_modules /usr/local/lib/berthward/bridge/node_modules
# The bridge's own files only. Its tests and their stand-ins for Discord and
# Claude are added in the "test" stage below and are not in the published image.
COPY bridge/bridge.ts bridge/lib.ts bridge/tasks.ts bridge/web.ts bridge/web-only.ts bridge/permission-mcp.ts bridge/package.json bridge/bun.lock /usr/local/lib/berthward/bridge/

# Docker CLI only (Debian's docker.io would pull in dockerd, containerd, runc).
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update && apt-get install -y --no-install-recommends \
      tini tmux git curl ca-certificates openssh-client \
      ripgrep jq procps \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Everything else the image adds is under rootfs/, laid out as it sits in the
# container: helpers in /usr/local/bin, and in /usr/local/share/berthward the
# base CLAUDE.md with its snippets, the shipped settings, the example tasks,
# tmux.conf and bashrc.
COPY rootfs/ /
# Interactive shells (Console button, docker exec -it ... bash) attach to the
# Claude session. System-wide so it applies regardless of the persisted home.
RUN printf '\n' >> /etc/bash.bashrc && cat /usr/local/share/berthward/bashrc >> /etc/bash.bashrc \
    && chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/generate-claude-md.sh \
             /usr/local/bin/host /usr/local/bin/boot-mode /usr/local/bin/logs /usr/local/bin/inspect /usr/local/bin/claude-guard \
             /usr/local/bin/claude-session /usr/local/bin/claude-settings-merge \
             /usr/local/bin/claude-bridge /usr/local/bin/claude-health /usr/local/bin/discord-send

# IS_SANDBOX is deliberately not set: it only serves to allow
# --dangerously-skip-permissions as root, which this image does not support.
ENV DISABLE_AUTOUPDATER=1 \
    TERM=xterm-256color \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /workspace

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD /usr/local/bin/claude-health

LABEL org.opencontainers.image.source="https://github.com/thecode/berthward" \
      org.opencontainers.image.description="Chat with your server on Discord and let it keep watch: Claude asks before every change and alerts you when something's wrong." \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]

# ── test: the runtime image plus the bridge's tests ──────────────────────────
# CI builds this stage (--target test) to run the tests with the image's own
# Bun and dependencies. Nothing is published from it.
FROM runtime AS test
COPY bridge/ /usr/local/lib/berthward/bridge/

# ── the published image ──────────────────────────────────────────────────────
# Last, so a plain `docker build` produces it.
FROM runtime
