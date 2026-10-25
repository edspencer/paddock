---
"@paddock/server": patch
---

Pressing Stop and then sending a new message no longer stalls for five minutes (#747). Claude Code doesn't fire its `Stop` hook when a turn is interrupted, so herdctl never learned the stopped turn had ended. The session stayed open, and the next message waited out herdctl's 5-minute resume ceiling, then started a second `claude` process on the same chat while the first one leaked. `@herdctl/core` 5.34.1 notices a turn that ends without that hook and closes the session, so the follow-up starts at once in a new chat, or within about 15 seconds in one with earlier turns (herdctl's turn-end grace on resumed sessions). Sending while background work (a shell, a dev server, a `Monitor`) is still running is unchanged and still waits; that is #806.
