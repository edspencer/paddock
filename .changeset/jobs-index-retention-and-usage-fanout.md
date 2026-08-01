---
"@paddock/server": patch
---

Two measured memory fixes on the hot read paths: the jobs index stops retaining
whole YAML documents, and `/chats/usage` stops opening a file per chat at once.

**The jobs index was holding every record body it exists to avoid holding
(#543).** `JobsDirIndex` keeps three small fields per `job-*.yaml` —
`session_id`, `finished_at`, `agent` — and its own docs promise "one ~100-byte
tuple per record, never the 24.5 KB average record body". That promise was
false. The `yaml` parser builds scalars by slicing the document text, and V8
represents those slices as SlicedStrings that pin the ENTIRE source string
alive, so caching a scalar verbatim retained the whole record.

Measured against this instance's jobs dir (2,016 records, 2,012 indexed),
driving the real index rather than a replica: **95.7 MB retained before, 1.9 MB
after** — ~94 MB off RSS for three `detachString` calls. Cold scan (1,175 vs
1,187 ms) and warm scan (38 vs 29 ms) are unchanged; this is a pure copy with
no semantic surface. Core hit the identical bug in its own job index and fixed
it the same way, so this matches that implementation rather than inventing a
variant.

**`/chats/usage` fanned out unbounded (#544).** The route mapped over every
session with `Promise.all`, so a project with 1,515 chats started 1,515
transcript reads at the same moment. The work is identical either way — the
reads just all land in memory at once instead of a few at a time. Bounded at
16, measured on that corpus against the real usage path, one cold process per
setting:

| concurrency | peak RSS |
|---|---|
| unbounded (1,515) | 1,025 MB |
| 64 | 646 MB |
| 32 | 555 MB |
| 16 | 522 MB |
| 8 | 375 MB |

**Peak RSS halves.** The results do not change: the bounded and unbounded maps
were diffed over all 1,515 chats and produce the same order and the same 460 KB
of serialised usage, which is the property the endpoint actually depends on
(callers index the result positionally).

Two figures in the design note behind this work did not reproduce and are
corrected here rather than repeated: the win is 2×, not the 4× estimated
against a standalone replica (the real path also reads each chat's sub-agent
transcripts, lifting both floor and ceiling), and "16 is *faster* than
unbounded" is not supportable — wall time varies 6.5–14.9 s for both settings
on this box, so the honest claim is no measurable latency cost.

The bound is a named constant in a new `concurrency.ts` because the planned
boot-warm sweep needs the same one. It is a local copy only because
`@herdctl/core` defines this helper twice and exports neither from its package
root; when herdctl#421 lands, this module should be deleted and the import
repointed at core.
