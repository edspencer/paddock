#!/usr/bin/env bash
# docs-media rig launcher.
#
# Stands up a Paddock instance that is safe to photograph: synthetic projects,
# a fake `claude`, an isolated Claude home, no credentials, no branding.
#
# Required env:
#   PADDOCK_RIG_HOME    scratch root — holds home/, data/, projects/
#   PADDOCK_RIG_CLONE   a built checkout (packages/{web,server}/dist)
# Optional:
#   PADDOCK_RIG_PROJECTS  projects root (default "$PADDOCK_RIG_HOME/projects")
#   PORT                  injected by the process manager; required
set -euo pipefail

RIG="${PADDOCK_RIG_HOME:?set PADDOCK_RIG_HOME}"
CLONE="${PADDOCK_RIG_CLONE:?set PADDOCK_RIG_CLONE}"

# ---------------------------------------------------------------------------
# Re-exec under a SCRUBBED environment. This is the load-bearing safety
# mechanism of the whole file, not a tidiness measure.
#
# A process manager copies the operator's whole environment. If an inherited
# CLAUDE_CODE_OAUTH_TOKEN meets a drive mode that ignores the fake `claude`,
# the rig quietly bills real money while LOOKING like it worked: turns complete
# fast, with plausible replies. `env -i` removes the ingredient rather than
# relying on remembering to unset it.
# ---------------------------------------------------------------------------
if [ -z "${DOCS_MEDIA_CLEANENV:-}" ]; then
  exec /usr/bin/env -i \
    DOCS_MEDIA_CLEANENV=1 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PORT="${PORT:-}" \
    TERM=xterm \
    PADDOCK_RIG_HOME="$RIG" \
    PADDOCK_RIG_CLONE="$CLONE" \
    PADDOCK_RIG_PROJECTS="${PADDOCK_RIG_PROJECTS:-}" \
    "$0" "$@"
fi

# --- isolation --------------------------------------------------------------
# HOME and CLAUDE_CONFIG_DIR must BOTH be isolated. PADDOCK_DATA_DIR isolates
# the data dir only; anything resolving the Claude home via os.homedir() lands
# on the operator's real ~/.claude — real transcripts and a real login.
export HOME="$RIG/home"

# Precedence is CLAUDE_CONFIG_DIR > `claudeHome:` > <dataDir>/claude-home.
# CLAUDE_HOME was removed (#691) and is IGNORED rather than an error, so a
# launcher still exporting it silently falls back to the default while you
# believe you isolated. Paddock also refuses to start if the home resolves to a
# user's own ~/.claude — a guard, not a substitute for setting this correctly.
export CLAUDE_CONFIG_DIR="$RIG/data/claude-home"
export PADDOCK_DATA_DIR="$RIG/data"

# --- the projects root ------------------------------------------------------
# MUST be on persistent storage. The previous rig pointed this at /home/demo on
# a box where only /data was a volume; a container restart destroyed every
# project.yaml and every .chats/*.jsonl while the data dir survived, leaving
# orphaned job records that reported chats whose transcripts were gone.
export PADDOCK_PROJECTS_DIR="${PADDOCK_RIG_PROJECTS:-$RIG/projects}"
export PADDOCK_WEB_DIST="$CLONE/packages/web/dist"

# --- exposure ---------------------------------------------------------------
# Auth is OFF, so bind LOOPBACK ONLY. Capture runs on the same host, so this is
# sufficient — and it means the rig is never reachable from the network. Do not
# reach for PADDOCK_DANGEROUSLY_ALLOW_OPEN to bind 0.0.0.0 instead: with auth
# off that publishes an unauthenticated instance.
export PADDOCK_AUTH_MODE=none
export HOST=127.0.0.1
export PADDOCK_OPENAPI_ENABLED=1
export LOG_LEVEL=info

# --- $0 turns ---------------------------------------------------------------
# The fake `claude` is a CLI stub, so turns MUST run on the batch runtime. The
# DEFAULT drive mode is `session`, which uses the SDK runtime, ignores PATH
# entirely, and would call the real API. This line is what stops real billing.
export PADDOCK_DRIVE_MODE=batch
export PATH="$CLONE/test/bin:$PATH"

# Belt and braces after `env -i`: derive the unset list from the environment
# rather than hand-writing it, so a newly-added credential var is covered.
for v in $(env | cut -d= -f1 | grep -E 'TOKEN|API_KEY|SECRET|PASSWORD|_KEY$' || true); do
  unset "$v" || true
done
unset PADDOCK_BRAND_NAME PADDOCK_BRAND_LOGO PADDOCK_BRAND_ACCENT || true

echo "docs-media rig: HOME=$HOME DATA=$PADDOCK_DATA_DIR PROJECTS=$PADDOCK_PROJECTS_DIR PORT=${PORT:-unset}"
exec node "$CLONE/packages/server/dist/cli/paddock.js" --port "${PORT:?PORT not injected}"
