"""Roll three root chats' lastSeen watermark back so they derive as UNREAD.

Why not the manual unread flag: AppShell's sidebar badge is
`unread || at > readLastSeen(sid)`, where `unread` is the MANUAL flag folded in
from the last /api/projects payload. Opening a chat only bumps the client's
in-memory lastSeen cache, so a manually-flagged chat clears its row dot but the
aggregate Home count stays stale until a refetch that never comes (the projects
context has no poll). A watermark-derived unread clears both, instantly — which
is the behaviour the shot is meant to show.

ReadStateStore is write-through and loads the file ONCE, so restart the server
after running this.
"""
import json
import os
import sys

SEP = chr(0)  # the store's key separator is a literal NUL
PATH = os.environ.get("PADDOCK_DEMO_DATA", "/data/scratch/paddock-video/data") + "/read-state.json"
OLD = 1785400000000  # comfortably before every seeded chat's last turn
IDS = [
    "e0e0d91d-4866-47ee-83ef-69e5e2519d01",  # NAS backup retention policy
    "bece32df-838f-4c95-b9f7-5a1d68d725ba",  # Rack UPS upgrade shortlist
    "328486b8-6bb8-4e60-814c-ae614471b086",  # Home network VLAN layout
]

data = json.load(open(PATH))
for sid in IDS:
    data["keeper-_root" + SEP + sid] = OLD
json.dump(data, open(PATH, "w"), indent=2)
print("patched %d entries" % len(IDS), file=sys.stderr)
