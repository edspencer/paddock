---
"@paddock/server": patch
"@paddock/web": patch
---

Surface turn errors & subscription/usage-limit hits in the UI (#329). When a
keeper turn was short-circuited by a synthetic runtime message (most commonly
the shared Claude Max-plan session/usage limit) or failed (network, API
5xx/overload, auth, crash, or hitting the max-turns cap), the chat used to just
stop with nothing shown. The turn now classifies these dead-ends and renders a
distinct inline notice — the reset time for a usage limit, and a Retry/Continue
affordance where it's safe to re-drive. Both the live streaming path and the
history-hydration path surface them (the usage-limit case is recovered from the
raw transcript on reload, since the parser otherwise drops synthetic messages).
