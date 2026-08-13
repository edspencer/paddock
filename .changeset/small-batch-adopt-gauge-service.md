---
"@paddock/server": patch
"@paddock/web": patch
---

Five small fixes, mostly to text that had drifted away from what the code does.

**Discover says "adopt"** (#817). #744 standardised the UI on "adopt" and the
docs recorded it as done; Discover then shipped saying "Import" throughout — so
the first screen a new instance shows disagreed with both the rest of the app and
the published documentation. "adopt" is the correct side: the endpoint underneath
is `adopt-chats`, and under `claude.transcripts: host` nothing is copied at all,
which is why the body copy claiming Discover "copies its conversations in" was
wrong too.

**The adoption routes' OpenAPI text** (#770). The same rename never reached the
API descriptions, which ship in `openapi.json` and in any generated client. Their
"repo-backed / notebook" phrasing is gone too — those terms were superseded by
the managed / linked-path axes in #206, and the text now says what the engine
actually matches on.

**`paddock service install --help`** (#818). It promised the data dir is left out
of the unit unless you pass `--data-dir`. `PADDOCK_DATA_DIR` in the installing
shell is also honoured, so the real precedence is flag > env > omitted. The
behaviour is deliberate — a service that ignored the env var would point
somewhere your terminal does not — but the help text was wrong in the direction
that leaves you with two instances you believe are one.

**The fleet readout's context gauge** (#819) lit one of six segments for a chat
measuring 0% context, while the hover said "Context 0% full" in the same breath.
A measured zero now reads empty; a barely-started chat still lights one segment,
so it cannot be mistaken for one that was never measured.

**An accent below its contrast floor is no longer silent** (#813, #816). The
solver already targets an AA floor per role and repairs what a theme derives from
it, but the verdict was computed and discarded, so the one case worth knowing
about — the floor it could not reach — was the invisible one. It now warns in
development. Nothing about the rendered colours changes.
