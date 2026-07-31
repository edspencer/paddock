"""Roll a workspace's run-history watermark back so the History tab shows its
"N new runs ran while you were away." banner again.

Opening the History tab POSTs `/runs/seen`, which advances the watermark and
retires the banner — so it is a ONE-SHOT on-camera moment, and every probe run
burns it. ReadStateStore loads the file once and writes through, so the server
must be restarted after this.

    python3 reset-runs-seen.py [agent]        # default: keeper-hushpod
"""
import json
import os
import sys

PATH = os.environ.get("PADDOCK_DEMO_DATA", "/data/scratch/paddock-video/data") + "/read-state.json"
OLD = 1785400000000
agent = sys.argv[1] if len(sys.argv) > 1 else "keeper-hushpod"

data = json.load(open(PATH))
data[agent + chr(0) + "__runs__"] = OLD
json.dump(data, open(PATH, "w"), indent=2)
print("reset %s runs watermark" % agent, file=sys.stderr)
