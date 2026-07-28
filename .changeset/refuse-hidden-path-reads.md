---
"@paddock/server": patch
---

fix(projects): refuse hidden (dot-prefixed) paths on the file surface, don't just omit them from listings.

`listFiles` has always dropped dot entries from what it *returns* — but that is
presentation, not access control. Naming the path explicitly still resolved it,
and the read route's `:name` param decodes `%2F`, so a nominally single-segment
route accepts a whole nested path. Together those made
`GET /api/projects/:slug/files/.chats%2F<id>.jsonl` return a full chat
transcript, and `…/files/.git%2Fconfig` return a git config — which carries
credentials when a remote embeds a token. `?path=.chats` likewise enumerated
every transcript filename.

The root project (#516) widened the blast radius from one project's subtree to
the instance's own backing repo and every project at once, which is what
prompted the audit.

`resolveInProject` now rejects any dot-prefixed segment, checked against the
RESOLVED path relative to the project dir — so `a/../.git` and `./.git` are
caught alongside a literal `.git`, while a project dir that legitimately sits
under a dot-prefixed ancestor (e.g. `/srv/.paddock/projects`) still works.

**Honest severity: defense-in-depth, not a privilege boundary.** Paddock has no
per-user role model, and any caller who can reach these routes can already start
a keeper chat and run Bash — strictly more capability than reading a file. The
`/mcp` read-only token surface exposes no file verb, so it was never reachable
there. Worth closing because "hidden in the listing" should not be the only
thing between an API and a transcript. Nothing in the UI regresses: the Files
browser never listed dot entries, so it never had a link to one.
