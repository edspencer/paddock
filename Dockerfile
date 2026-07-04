# Paddock application image.
#
# Paddock is an APP (server + built web SPA), not a library — this image is the
# unit of deployment. It bundles the Fastify server, the built React SPA, and the
# `claude` CLI that Paddock shells out to via @herdctl/core's cli runtime.
#
# Runtime requirements (supplied at `docker run` time, NOT baked in):
#   - CLAUDE_CODE_OAUTH_TOKEN   Claude Max auth (runtime: cli). Or ANTHROPIC_API_KEY for sdk.
#   - a volume mounted at /data  Persistent project store + Claude session transcripts.
#                                (HOME=/data so ~/.claude/projects survives restarts → resume works.)
#   - GITHUB_TOKEN (optional)    Enables git push to the backing repo (configured by entrypoint).
#
# Multi-arch (linux/amd64, linux/arm64) is built in CI via buildx.

# ---- build stage ----------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install deps first (cache layer) — workspace manifests before sources.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

# Build server (tsc) + web (vite).
COPY . .
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    PADDOCK_DATA_DIR=/data \
    HOME=/data

# System deps + GitHub CLI + the Claude CLI that Paddock spawns (runtime: cli).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Production dependencies only (dev deps like vite/tsc/playwright are build-time).
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev

# Built artifacts. The server resolves the SPA at ../../web/dist relative to
# packages/server/dist, so this layout needs no PADDOCK_WEB_DIST override.
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# Configure git auth from GITHUB_TOKEN (if provided) then exec the server.
RUN printf '#!/bin/sh\nif [ -n "$GITHUB_TOKEN" ]; then\n  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"\nfi\nmkdir -p "$PADDOCK_DATA_DIR"\nexec "$@"\n' > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
