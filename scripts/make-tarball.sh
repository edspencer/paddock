#!/usr/bin/env bash
# Build a self-contained Paddock release tarball from an already-built tree.
#
# Assumes `npm run build` has run (packages/{server,web}/dist exist). Produces
# paddock-<version>.tgz containing exactly what a host needs to run the app:
#   package.json + package-lock.json (for `npm ci --omit=dev`)
#   packages/server/{package.json,dist}
#   packages/web/{package.json,dist}
#   INSTALL.md (run instructions)
#
# Consumer:  tar xzf paddock-<v>.tgz && cd paddock && npm ci --omit=dev \
#            && PADDOCK_DATA_DIR=/var/lib/paddock node packages/server/dist/index.js
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./packages/server/package.json').version")"
OUT="paddock-${VERSION}"
STAGE="dist-tarball/${OUT}"

test -d packages/server/dist || { echo "packages/server/dist missing — run 'npm run build' first" >&2; exit 1; }
test -d packages/web/dist    || { echo "packages/web/dist missing — run 'npm run build' first" >&2; exit 1; }

rm -rf dist-tarball
mkdir -p "${STAGE}/packages/server" "${STAGE}/packages/web"

cp package.json package-lock.json "${STAGE}/"
cp packages/server/package.json "${STAGE}/packages/server/"
cp -R packages/server/dist "${STAGE}/packages/server/dist"
cp packages/web/package.json "${STAGE}/packages/web/"
cp -R packages/web/dist "${STAGE}/packages/web/dist"

cat > "${STAGE}/INSTALL.md" <<EOF
# Paddock ${VERSION} — tarball install

\`\`\`sh
npm ci --omit=dev
PADDOCK_DATA_DIR=/var/lib/paddock \\
CLAUDE_CODE_OAUTH_TOKEN=... \\
PORT=4000 HOST=0.0.0.0 \\
node packages/server/dist/index.js
\`\`\`

Requires Node.js >= 22 and the \`claude\` CLI on PATH
(\`npm i -g @anthropic-ai/claude-code\`). See the Docker image
(ghcr.io/edspencer/paddock:${VERSION}) for a batteries-included alternative.
EOF

tar -czf "${OUT}.tgz" -C dist-tarball "${OUT}"
( command -v sha256sum >/dev/null && sha256sum "${OUT}.tgz" || shasum -a 256 "${OUT}.tgz" ) > "${OUT}.tgz.sha256"
rm -rf dist-tarball

echo "built ${OUT}.tgz"
cat "${OUT}.tgz.sha256"
