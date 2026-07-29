---
"@paddock/server": patch
"@paddock/web": patch
---

Remove the legacy `target` WebSocket alias for `projectSlug` (#551). Every
server→client frame carried `target` as a byte-for-byte duplicate of
`projectSlug`, and five client→server message types accepted it as an alias — a
compatibility surface for "early frontends" that do not exist, since the server
and the SPA ship as one artifact from one repo.

Frames now carry `projectSlug` only. Nothing read the alias: the web client sent
`projectSlug` at every send site, and the single server→client fallback was
unreachable because `projectSlug` is required on every emitted payload type and
every emit site sets it — including the root workspace's `""` (a *present* empty
string) and `"?"` on the invalid-frame path.

The `chat:send` payload documentation now also records that `""` is the legal
ROOT workspace key, and that it must be tested with `=== undefined` rather than
for falsiness — the fact most likely to be re-broken, and the one the comment
omitted.
