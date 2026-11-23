# syntax=docker/dockerfile:1
#
# claude-sessions-mcp: an MCP server (Streamable HTTP at /mcp, GET /health)
# for one owner's Claude Code cloud sessions, with the Claude Code CLI
# pinned beside it for the claude.ai sign-in and to start sessions. Runs as
# uid 10001, never root; keeps the login in /home/claude/.claude (a named
# volume, never shared with another container: the refresh token rotates).
#
#   docker run -d --name claude-sessions -p 127.0.0.1:8080:8080 \
#     -v claude-sessions-login:/home/claude/.claude -e MCP_AUTH_TOKEN \
#     --cap-drop ALL --security-opt no-new-privileges \
#     ghcr.io/kaperkunde/claude-sessions-mcp@sha256:<digest>
#
# See README.md, "Where it connects".

ARG NODE_IMAGE=docker.io/library/node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ARG PNPM_VERSION=10.33.0
# The Claude Code CLI: the version the sessions API was tested with, and the
# npm integrity of its native musl package per platform. A new version is a
# change here, then scripts/smoke.ts (README.md, "After a CLI update").
ARG CLAUDE_CODE_VERSION=2.1.327
ARG CLAUDE_CODE_SHA512_X64=sha512-GhxvaKxZSNSFOyGP3Dwm+QoHz2h5TMmONN+GXb4xH4tbWT5AnvoCT6P62r342fTdGoonVEigEH1bnkcALNzLOw==
ARG CLAUDE_CODE_SHA512_ARM64=sha512-zVRKZ1IdMOvm7M4Y0FIuJY1g3BWnpGVUOv8Fu8kGHYk0WbkES1BkuJG0O/6Jzd+LhkadEmBypz0odbGqvoqD+w==

# ---- build: compile TypeScript -----------------------------------------------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
RUN npm install -g --no-update-notifier "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- deps: production dependencies only, exactly as locked -------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN npm install -g --no-update-notifier "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- claude: the CLI's native binary, checked against its pinned integrity ---
# No install script runs: the platform package's tarball is fetched, its
# sha512 compared with the one pinned above, and its one binary taken out.
FROM ${NODE_IMAGE} AS claude
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION
ARG CLAUDE_CODE_SHA512_X64
ARG CLAUDE_CODE_SHA512_ARM64
WORKDIR /cli
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x64; want="$CLAUDE_CODE_SHA512_X64" ;; \
      arm64) arch=arm64; want="$CLAUDE_CODE_SHA512_ARM64" ;; \
      *) echo "No Claude Code build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    npm pack --silent --ignore-scripts \
      "@anthropic-ai/claude-code-linux-${arch}-musl@${CLAUDE_CODE_VERSION}"; \
    file="anthropic-ai-claude-code-linux-${arch}-musl-${CLAUDE_CODE_VERSION}.tgz"; \
    got="$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write("sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64"))' "$file")"; \
    if [ "$got" != "$want" ]; then echo "Integrity mismatch for $file" >&2; exit 1; fi; \
    tar -xzf "$file" package/claude; \
    install -m 0755 package/claude /cli/claude; \
    rm -rf package "$file"; \
    DISABLE_AUTOUPDATER=1 /cli/claude --version | grep -q "^${CLAUDE_CODE_VERSION} "

# ---- runtime -------------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION
LABEL org.opencontainers.image.source="https://github.com/kaperkunde/claude-sessions-mcp" \
      org.opencontainers.image.description="Claude Code cloud sessions over MCP for PCP, on the owner's own claude.ai login" \
      org.opencontainers.image.licenses="MIT" \
      gg.pcp.claude-code.version="${CLAUDE_CODE_VERSION}"

# No package manager at run time: npm, npx, corepack and yarn go.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && adduser -D -u 10001 -h /home/claude -s /sbin/nologin claude \
    && mkdir -p /home/claude/.claude \
    && chown -R 10001:10001 /home/claude \
    && chmod 700 /home/claude /home/claude/.claude

COPY --from=claude /cli/claude /usr/local/bin/claude
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE ./

ENV NODE_ENV=production \
    HOME=/home/claude \
    CLAUDE_CONFIG_DIR=/home/claude/.claude \
    CLAUDE_BIN=/usr/local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080

USER 10001:10001
VOLUME ["/home/claude/.claude"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/main.js"]
