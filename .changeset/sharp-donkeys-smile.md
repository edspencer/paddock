---
"@paddock/server": minor
"@paddock/web": minor
---

Stop a single piece of background work from the running-work bar. Each row gets a ✕, and a **Stop all** appears in the header once more than one thing is running — so a session with fifteen stray shells no longer has to be reaped whole, or asked nicely.

Stopping a **shell** takes one click, since it is cheap to relaunch. Stopping a **sub-agent** asks first, and says the thing the row cannot: the kill cascades to everything that sub-agent started. **Stop all** always asks.

The three things that can happen are kept apart, because only one of them is a failure: the row is held at `stopping…` until the runtime's own terminal notification removes it; a task whose session has already gone simply leaves the bar; and a stop the runtime **refuses** — a `monitor_mcp` task, which cannot be killed — says `can't stop` and stays live and retryable, rather than hanging at `stopping…` or pretending to have worked. Rows the server knows cannot be stopped are not offered the button at all, and a hold that goes unanswered releases itself rather than stranding the row.
