#!/usr/bin/env bash
#
# migrate-chat.sh <source-transcript.jsonl> <target-slug> [ssh-host]
#
# Migrate a Claude Code conversation transcript into a paddock project so it
# shows up as one of that project's chats (and is resumable). It:
#   1. rewrites the transcript's `cwd` to the project's working dir on the host,
#   2. copies it into <project>/.chats/<session-id>.jsonl (the symlinked
#      transcript location), preserving the original last-message mtime,
#   3. synthesizes a herdctl job record so paddock attributes the session to the
#      project's keeper agent (without it, getAgentSessions hides the chat).
#
# After migrating one or more chats, restart paddock once so the attribution
# index rebuilds:  ssh <host> systemctl restart paddock
#
# Usage:
#   scripts/migrate-chat.sh ~/.claude/projects/<enc>/<sid>.jsonl multi-zone-ac
#
# NB: no `pipefail` — `grep … | head -1` on a large transcript makes grep exit
# with SIGPIPE (141) once head closes the pipe; with pipefail that would abort
# the script. The trailing head/tail/sed determine success, so this is safe.
set -eu

SRC="${1:?source transcript .jsonl required}"
SLUG="${2:?target project slug required}"
SSH_HOST="${3:-projects}"

[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

PROJDIR="/var/lib/paddock/projects/$SLUG"
SID="$(basename "$SRC" .jsonl)"

SRCCWD="$(grep -m1 -o '"cwd":"[^"]*"' "$SRC" | head -1 | sed 's/"cwd":"//;s/"$//')"
[ -n "$SRCCWD" ] || { echo "could not read cwd from $SRC" >&2; exit 1; }

FIRST="$(grep -o '"timestamp":"[^"]*"' "$SRC" | head -1 | sed 's/.*:"//;s/"//')"
LAST="$(grep -o '"timestamp":"[^"]*"' "$SRC" | tail -1 | sed 's/.*:"//;s/"//')"
DATE="${LAST:0:10}"
DUR="$(node -e "console.log(Math.max(0,Math.round((new Date('$LAST')-new Date('$FIRST'))/1000)||0))")"
EPOCH="$(node -e "console.log(Math.floor(new Date('$LAST').getTime()/1000))")"
JOBID="job-$DATE-${SID:0:6}"

echo "migrating $SID  ($SRCCWD)  ->  $SLUG"

# 1+2: rewrite cwd locally, ship into the project's .chats (the symlink target)
TMP="$(mktemp)"
sed "s#\"cwd\":\"$SRCCWD\"#\"cwd\":\"$PROJDIR\"#g" "$SRC" > "$TMP"
scp -q "$TMP" "$SSH_HOST:$PROJDIR/.chats/$SID.jsonl"
rm -f "$TMP"

# 3: preserve the real date + synthesize the attribution job record
ssh "$SSH_HOST" "bash -s" <<EOF
set -e
touch -d @$EPOCH "$PROJDIR/.chats/$SID.jsonl"
cat > /var/lib/paddock/.herdctl/jobs/$JOBID.yaml <<YAML
id: $JOBID
agent: keeper-$SLUG
schedule: null
trigger_type: web
status: completed
exit_reason: success
session_id: $SID
forked_from: null
started_at: $FIRST
finished_at: $LAST
duration_seconds: $DUR
output_file: /var/lib/paddock/.herdctl/jobs/$JOBID.jsonl
YAML
touch /var/lib/paddock/.herdctl/jobs/$JOBID.jsonl
echo "  placed transcript + job record $JOBID"
EOF
