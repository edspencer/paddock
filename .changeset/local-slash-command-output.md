---
"@paddock/server": patch
"@paddock/web": patch
---

Render client-local slash commands (`/context`, `/usage`, …) correctly (#158). These commands render their output to a `type:"system"` / `local_command` transcript entry (live: a `model:"<synthetic>"` assistant placeholder) that @herdctl/core's parser and @herdctl/chat's translator both drop — so the command turn used to show nothing useful, leaving only the raw `<command-name>` / `<local-command-*>` scaffolding as empty/user bubbles. Paddock now surfaces the recovered output as a clean, labeled "command output" block in BOTH the live path (ws.ts, mirroring the existing `compact_boundary` note) and on history reload (a new `localcommand.ts` recovery pass re-injects the dropped `<local-command-stdout>`), and the web drops the `<local-command-caveat>` framing note instead of rendering it. `/context` renders its full usage table; `/usage` shows session cost (its plan/rate-limit portion needs an OAuth token with `user:profile` scope, which the keeper token lacks). Paddock's own context ring + cost meter remain the primary usage view.
