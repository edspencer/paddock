---
"@paddock/server": minor
---

Discover: a read-only API that finds directories on this machine with existing
Claude Code history and proposes them as projects (#745, server half).

`GET /api/discover` enumerates `<claudeHome>/projects/*`, recovers each folder's
recorded cwd from a transcript (never by inverting the lossy encoded folder
name), and returns the directories a human would actually recognise as a
project, ranked by how many non-noise sessions each holds.
`GET /api/discover/sessions?dir=…` lists one directory's sessions so a client can
expand a row lazily and tick sessions individually.

The heuristic is the feature: a naive scan surfaces ~166 transcript folders on a
real developer machine, ~150 of them ephemeral temp-dir sessions, plus `/`,
`~/Downloads` and `/tmp`. Rules run cheap-to-expensive — no recorded cwd,
missing, system path (`/` and the #720 denylist, on both the resolved and the
as-written spelling), temp root, inside Paddock's own directories, `$HOME`
itself, outside `$HOME`, overlapping an existing project, no `.git`, no
surviving sessions — so the ~150 die on string comparisons before anything reads
a transcript. `includeNonGit=1` and `includeOutsideHome=1` relax the two soft
rules; `excluded` reports what each rule ate, so a container that legitimately
finds nothing can say why instead of rendering a blank page.

This is a NEW, instance-level endpoint rather than a loosening of
`POST …/adopt-chats`, which deliberately refuses a `sourceCwd` its project does
not offer. Its own containment: the only paths it will read are ones a transcript
folder already records and that clear the same path floor a linked project must
(#718–#721), so `?dir=` is a lookup into a computed set, not a path parameter.
No UI yet.
