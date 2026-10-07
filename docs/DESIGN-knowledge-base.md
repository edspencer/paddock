# Design: Knowledge base

Status: **discussion draft (2026-10-07)**. Branch `design/knowledge-base`. Nothing
here is decided until it appears in §12 *Decision log*. This doc is updated in
batches as the design conversation moves; it is the place the design lives, not
the chat.

---

## 1. Problem

Over weeks and months, a Paddock project accumulates **resources**: PDFs and
spreadsheets the user uploads, links pasted in (GitHub issues/PRs/source, Notion
pages, Google Docs, product pages), and files and links the agent sends back.
Today almost all of that is **lost to every chat except the one it arrived in**,
and eventually lost to that chat too (context limits, compaction, `/clear`, new
chats).

What exists today is the **sweeper** (`sweep.ts`): a tool-less, Haiku-class,
post-turn curator that regenerates `OVERVIEW.md`, appends a bullet to
`CHANGELOG.md`, and (non-repo projects only) appends to `CLAUDE.md`. Its limits,
measured against the code:

- **It sees a narrow, lossy window.** `buildDigest` (`sweep.ts`) re-reads at most
  **6** sessions newer than the watermark, the **last 40 messages** of each, text
  trimmed to **600 chars** and tool calls collapsed to `[tool name summary]`. A
  link in message 41-from-the-end, past char 600, or inside a tool result is
  never seen. Sweeps are debounced to one per 5 min per project.
- **Nothing extracts links today.** There is no server-side URL detection at all;
  the web autolinks via `remark-gfm` and that's it.
- **Uploads carry almost no metadata.** The original filename exists only in the
  transcript's `<paddock-attachments>` block; `send_file` keeps no source path.
- **It is a prose summariser, not an index.** Nothing it writes is addressable:
  there is no "the v3 spec PDF" object an agent can find, open, or cite.
- **Its budgets are small.** Defaults are 2k tokens (OVERVIEW), 8k (CHANGELOG),
  6k (CLAUDE.md curated section) — `curation-config.ts` `DEFAULT_CURATION`.
  A list of 50 resources with a sentence each doesn't fit in OVERVIEW.
- **It fights the chat agents.** Chat agents edit `OVERVIEW.md`/`CHANGELOG.md`
  directly (they have nowhere sanctioned to put durable notes), and the next sweep
  rewrites OVERVIEW wholesale.
- **Its source material is mortal.** Uploaded/sent files live in the
  `AttachmentStore` as `<uuid><ext>` and are **deleted with the chat that
  referenced them** (`attachments.ts`, `collectAttachmentIds`).

Motivating cases:

- **House instance** — one Paddock per household; projects per job (water heater,
  roof). Blueprints, wiring diagrams, spreadsheets and product links that matter
  across many jobs.
- **Work project with a multi-chat sub-project** — a parent chat with five child
  chats, several dozen resources (multiple versions of the same Google-Docs-exported
  PDF, GitHub issues/PRs across several repos, Notion pages). Future sibling
  sub-projects will overlap with it.

## 2. Goals / non-goals

**Goals**

1. **Capture is automatic and complete.** Every file and link that crosses a chat
   boundary, in either direction, is recorded — without the user saying "commit
   this".
2. **Any chat can find it.** A fresh chat (or a different project, where allowed)
   can discover "what do we know / have about X" cheaply.
3. **Organised, not just piled up.** A browsable structure that reflects
   sub-projects, maintained by a background agent.
4. **Provenance and time are first-class.** Every item knows which chat(s)
   introduced/used it and when — enabling per-project and per-chat timelines.
5. **Versions are recognised.** A newer export of the same document is linked to
   (and supersedes) the older one.
6. **Visible and steerable in the UI**, including a chat that knows the KB.
7. **Works on every project shape** — repo-backed, notebook, and an instance root.
8. **Opt-out-able, cheap by default.** No mandatory third-party key.

**Non-goals (for v1)**

- General "remember every fact the user says" conversational memory. (Claude
  Code's own auto-memory exists for that; see §10.) v1 is about **resources**,
  with *notes* as one resource type.
- Keeping linked content perpetually fresh (see §7.4 — a later phase).
- Multi-user permissions beyond what the instance already has.

## 3. Requirements captured from the brief

| # | Requirement (as stated) | Notes |
|---|---|---|
| R1 | Trigger on: file uploaded, file sent by agent, link sent either direction; possibly more | §6.1 |
| R2 | Background (side-channel) agent maintains the structure, not the chat agent | §6.3 |
| R3 | Tree structure; agent may restructure (e.g. hoist a shared item to a common ancestor) | §5.2 — **revised** |
| R4 | Instance-level root above projects; projects are 2nd-level; arbitrary depth below | §5.2 |
| R5 | Items tagged with project and chat(s), with what each chat did and when | §5.3 |
| R6 | Timeline views: whole KB, per project, per chat | §8 |
| R7 | Node fields: title, description (one line), summary (paragraphs), tags, content attachment | §5.1 |
| R8 | Extensible content kinds; min. files and links | §5.1 |
| R9 | Version detection for newer copies of a document | §6.4 |
| R10 | Search tool (MCP); submit tool (MCP); agents nudged to use them | §7 |
| R11 | Optional embeddings / RAG, user-supplied provider; fallback to agentic tagging | §7.2 |
| R12 | Storage in the Paddock data dir; DB vs flat file undecided | §9 |
| R13 | KB writes enqueue updates to OVERVIEW/CHANGELOG, batched (transaction), not per write | §6.5 |
| R14 | Generalise derived files as `{filename, prompt}` entries, all re-run on a trigger | §6.5 |
| R15 | UI to browse the KB, with a chatbot that knows it | §8 |
| R16 | Configurable: on/off, embeddings on/off | §11 |

## 4. Concepts

- **Resource** — a thing that exists outside the conversation: a file (bytes), a
  link (URL), and later an MCP-addressable document (e.g. a Google Doc id).
- **Item** — the KB's record *about* a resource: title, description, summary,
  tags, provenance. One resource → one item (dedupe is a core job).
- **Note** — an item with no external resource; durable text an agent or user
  chose to keep. This is the sanctioned home for what chat agents currently try to
  put in OVERVIEW.md.
- **Topic** — an organising node in the hierarchy ("Roof replacement", "Billing
  migration › API v2 spec"). Topics contain items and other topics.
- **Mention / event** — one occurrence of a resource in one chat at one time
  ("user uploaded", "agent sent", "user linked", "agent linked", "agent read").
  Append-only. The timeline is built from these, not from items.
- **Curator** — the background agent that turns new mentions into item and topic
  changes.
- **Projection** — a file derived from the KB (OVERVIEW.md, CHANGELOG.md, …),
  regenerated from KB changes. Generalises today's sweeper outputs.

## 5. Data model

### 5.1 Item

```
id            stable id
kind          file | link | note | (extensible: gdoc, notion, gh-issue, …)
canonical     canonical identity: sha256 for files; normalised URL for links;
              kind-specific key (e.g. github:owner/repo#123) where one exists
title, description (one line), summary (paragraphs, optional, derived)
tags[]
content       file: blob ref (content-addressed) + mime + size + extracted text ref
              link: url, fetched-at, snapshot ref (optional), auth-walled flag
lineage       supersedes / superseded_by (version chain) — §6.4
created_at, updated_at, last_mentioned_at
scope         instance | project:<slug>   (visibility — §7.3)
```

### 5.2 Hierarchy — tree of topics, items attached to many

**Revision of R3.** The brief describes a single tree whose nodes *are* the
resources, with shared resources hoisted to a common ancestor. Hoisting conflates
*where something is relevant* with *where it lives*: an item mentioned in two
sub-projects moves up and becomes harder to find from either; frequently-used
items drift to the root and the tree flattens over time.

Proposed instead:

- **Topics form a strict tree** (easy to render, easy for an agent to reason
  about). `root (instance) → project → topic → topic …`.
- **Items attach to one or more topics** (a polyhierarchy). An item shared by two
  sub-projects is filed under both. It has one *home* (primary topic, used for
  display paths) and any number of additional placements.
- **Hoisting still exists**, but as a deliberate curator act on *topics* ("these
  two sub-projects share a body of material → create a shared parent topic"), not
  as an automatic side-effect of a second mention.

### 5.3 Relationships (the "other structures")

1. **Containment** — topic ⊃ topic, topic ∋ item. (The tree.)
2. **Scope** — item/topic ↔ project (or instance).
3. **Provenance** — item ↔ chat(s), via mentions, each with an operation
   (uploaded, sent, linked, read, cited, edited) and timestamp.
4. **Time** — derived from mentions; any scope can be flattened to a timeline.
5. **Versioning** — item `supersedes` item (doc v2 → v1). A chain, not a tree.
6. **Association** — item ↔ item, typed: `references`, `implements`/`fixes`
   (PR → issue), `derived-from` (summary/spreadsheet built from a PDF), `about`
   (both concern the same entity). See §13 Q1 — this may be the relationship the
   brief couldn't recall.
7. **Chat lineage** (already exists) — parent chat → child chats. A free,
   user-authored signal of sub-project structure; the curator should use it as
   the default seed for topics (§6.3).

## 6. Pipeline

### 6.1 Capture (deterministic, no LLM)

After each turn (and on upload), Paddock extracts **mention events** from the
transcript delta since a **per-chat watermark** — every chat, not the 3 newest:

- user upload → attachment id (+ hash the bytes)
- `send_file` → attachment id / path
- URLs in user and assistant text, and in tool *inputs* the agent issued
  (WebFetch, `gh` commands) — normalised and canonicalised
- (later) MCP reads of external docs, `Read` of files under the project dir

Rules: strip credentials from URLs (query tokens, `user:pass@`, signed URLs —
this box's own `git remote -v` embeds a PAT); drop dev/preview hosts and
localhost by default; record but de-prioritise noisy classes (CI run links,
raw.githubusercontent assets).

Hook points (existing): a second listener on `PaddockEventBus` `afterTurn`
(`event-bus.ts`; the sweeper's listener is in `ws-triggers.ts`). `afterTurn`
does **not** fire for failed turns, so uploads also capture at the upload route
(`routes/meta.ts`) and `send_file` at its handler (`send-file-mcp.ts`). The
capture reads the JSONL itself (incl. sub-agent sidechain transcripts), because
the transcript on disk keeps pre-compaction content and so stays lossless.

Output: rows in an append-only **mention log**. This is lossless and cheap, and
it is the foundation for timelines regardless of what the curator later does.

### 6.2 Retention

When a file is captured, its bytes are copied into a **content-addressed blob
store** owned by the KB (`sha256/…`). Deleting a chat then no longer deletes the
KB's copy (the AttachmentStore's cleanup stays as-is for its own copies).
Dedupe falls out of hashing.

### 6.3 Curation (LLM, batched)

A per-instance **curator** consumes unprocessed mentions in batches (debounced,
like the sweeper's `minIntervalMs`) and emits **operations** through KB MCP
tools: `create_item`, `update_item`, `attach(item, topic)`, `create_topic`,
`move_topic`, `link(a, rel, b)`, `mark_superseded`, `noop`.

Guidance it needs (draft — §13 Q4):

- **Default placement follows chat lineage.** A mention in a child chat files
  under the topic for the root of that chat's family; create it if absent,
  named from the parent chat.
- **Prefer attach over create.** If a canonical match exists, add a placement
  and update; never a duplicate item.
- **Create a sub-topic** when a topic exceeds ~N items *and* a coherent cluster
  of ≥3 exists; never for a single item.
- **Create a shared parent topic** when two sibling topics share ≥K items;
  don't move items, re-parent topics.
- **Never delete**; supersede or archive.
- Every op cites the mention ids that justify it.

Ops are applied by Paddock (the curator never writes storage directly) and
recorded in an **op log**, grouped into a **transaction** per curator run. The op
log gives undo, audit, the "what changed" diff for projections, and a replayable
history.

### 6.4 Version detection

Candidates: same title/filename stem with version-ish tokens (`v2`, `(1)`,
`final`, dates), high text similarity of extracted text (MinHash/shingles),
same source URL (e.g. the same Google Doc exported twice). The curator confirms
with a judgement call; Paddock records `supersedes`. Search returns the newest
by default, with older versions one hop away.

### 6.5 Projections (generalised sweeper)

A projection is `{ file, prompt, budget, inputs }`. OVERVIEW.md and CHANGELOG.md
become two built-in projections. They are triggered by **committed KB
transactions** (debounced), receive the transaction diff + the current file +
whatever else `inputs` names (recent chat digest, the topic tree), and stay
**tool-less, text-out, Paddock-writes** — the property that makes today's sweeper
safe. Projections are independent, so they run in parallel.

Open: whether the transcript-digest path (today's sweeper input) remains a
trigger alongside KB transactions — some project changes never involve a
resource (§13 Q5).

## 7. Retrieval

### 7.1 MCP tools (chat agents)

- `kb_search(query, scope?, kind?, include_superseded?)` → ranked items with
  title/description/path/provenance.
- `kb_get(id)` → full item incl. summary and a readable path/URL to content.
- `kb_browse(topic?)` → children of a topic.
- `kb_note(title, body, topic?)` / `kb_submit(resource, why)` → enqueue for the
  curator (chat agents propose; the curator disposes).

### 7.2 Search without embeddings

At this scale (hundreds to low thousands of items per instance) the primary
retrieval should be **lexical + structural**: SQLite FTS5 (BM25) over title,
description, summary, tags and extracted text, plus scope/topic filters — and
the agent browsing the topic tree. Embeddings are an **optional** add-on
(hybrid rerank), with a provider configured by the installer — research in
§10 on what's available.

### 7.3 Scope rules

A chat sees: its project's subtree + instance-level items. Cross-project reads
are opt-in per instance (`knowledge.crossProject`) — the house instance wants it,
a work instance with client projects may not.

### 7.4 Making agents actually use it

Tools alone are under-used. Inject a short **KB index** into a new chat's
context (as OVERVIEW is offered today): the chat's topic, its top items by
recency, and one line telling the agent the tools exist. Freshness/refresh of
linked content (issue closed, doc edited) is a later phase.

## 8. UI

- **Knowledge** tab per project, and at instance level: topic tree (left), item
  list/detail (right), with provenance chips linking back to the exact message.
- **Timeline** view: mentions over time, one lane per chat (or collapsed per
  project); chat lanes nest following chat lineage.
- **Knowledge chat** — a user-facing chat with KB read/write tools. See §13 Q6 on
  whether this is the curator itself.

## 9. Storage

Options: (a) SQLite in the data dir (FTS5 built in; Node ≥22 `node:sqlite` or
`better-sqlite3`), (b) markdown files per item/topic (git-diffable, human-
editable), (c) JSON sidecars (Paddock's current pattern). Leaning: SQLite as the
store of record + content-addressed blob dir, with an export to markdown for
git/backup visibility. Must be included in the instance's backup story (chats
are protected by restic, not git).

## 10. Research notes (2026-10-07)

### 10.1 Embeddings

- **Anthropic has no embeddings API**, so the subscription/OAuth token is moot;
  Anthropic's docs point at Voyage AI
  (https://platform.claude.com/docs/en/build-with-claude/embeddings).
- **Voyage** needs its own key (MongoDB Atlas). `voyage-4-lite` $0.02/1M tokens,
  `voyage-4` $0.06, first 200M tokens free; `voyage-context-4` embeds chunks with
  whole-document context; `voyage-4-nano` is open-weights (Apache 2.0).
- **Local, no key**: transformers.js (ONNX in Node) with `bge-small-en-v1.5`
  (384d, ~33M params), `nomic-embed-text-v1.5`, or EmbeddingGemma-300m (<200MB
  quantized, multilingual); `fastembed-js`; or Ollama as a sidecar daemon.
- **Storage**: SQLite FTS5 (BM25) + `sqlite-vec`, fused with reciprocal rank
  fusion; FTS5 keeps working if the extension fails to load. LanceDB is the
  embedded alternative.
- **Implication**: provider ladder `none (FTS5 only) → local → voyage`. Default
  `none` costs nothing and needs no download.

### 10.2 Prior art

| System | Data model | Add vs update | Staleness |
|---|---|---|---|
| Graphiti / Zep | temporal KG: entities, facts, episodes; bi-temporal edges | resolve against existing entities | contradicted facts get `invalid_at`, never deleted |
| mem0 | flat facts (+ optional graph) | LLM picks ADD/UPDATE/DELETE/NOOP vs similar memories | overwrite — **no history** |
| Letta / MemGPT | core blocks (in prompt) / recall / archival | agent self-edits; "sleep-time" agent consolidates in background | agent-managed |
| Basic Memory | markdown files = entities; observations; wiki-link relations; SQLite index; MCP | LLM edits notes via tools | git + human |
| Karpathy "LLM wiki" | `raw/` sources compiled into interlinked markdown wiki | each new source updates pages | contradictions noted inline |
| RAPTOR | bottom-up cluster→summarise tree | batch rebuild, not incremental | rebuild |
| A-MEM | Zettelkasten atomic notes + links | new notes rewrite neighbours' context/tags | none |
| Claude Code auto-memory | `MEMORY.md` index + topic files per repo | agent-maintained | agent-maintained |

The closest fits are **Karpathy's wiki** (raw sources kept, LLM compiles an
organised layer on top) and **Graphiti** (never delete, invalidate with time).
mem0's destructive UPDATE/DELETE is the pattern to avoid.

### 10.3 Failure modes to design against

- **Consolidation drift**: research in 2026 finds memory that an LLM keeps
  rewriting first helps, then degrades below a no-memory baseline. Keeping raw
  episodes as primary evidence restored it (arXiv 2605.12978). Paddock already
  has an instance of this: #870, where the sweeper re-inverted a documented decision.
- **Memory can hurt even when retrieval is right** (MemTrapBench, 2608.20202),
  through anchoring and belief distortion. Present KB results as *evidence with
  provenance*, not as instructions.
- Duplicates, wrong grouping, over-generalisation, hallucinated summaries,
  and misses when the query's vocabulary doesn't overlap the item's.
- **Evaluation**: LongMemEval and LoCoMo exist, but our real eval is a pilot
  (§14) with a no-KB baseline.

### 10.4 Version detection

Tiered: exact hash → normalised filename/title (strip `v2`, `(1)`, `final`,
dates) → MinHash/SimHash Jaccard ~0.5–0.8 means "revised, same doc" → (optional)
embedding cosine → LLM judge only for borderline pairs → timestamps decide
direction. MinHash is small enough to hand-write.

## 11. Configuration (sketch)

```yaml
knowledge:
  enabled: true            # capture + curate
  curator: { model: haiku, minIntervalMs: 300000 }
  crossProject: false
  capture: { links: true, files: true, dropHosts: [localhost, "*.dev.example"] }
  embeddings: { provider: none }   # none | local | voyage | openai-compatible
  projections:
    - { file: OVERVIEW.md,  prompt: builtin:overview,  budget: 2000 }
    - { file: CHANGELOG.md, prompt: builtin:changelog, budget: 8000 }
```

## 12. Decision log

_(empty — nothing decided yet)_

## 13. Open questions

1. **The forgotten relationship.** Candidates: association (§5.3 #6), versioning
   (#5), entity "aboutness" (the same water heater / the same repo).
2. **Store of record**: SQLite vs markdown files.
3. **Curator granularity**: one per instance (global consistency, serial) vs one
   per project (parallel, but who edits the root?).
4. **Curator guidance thresholds** (§6.3) — need the pilot to tune.
5. **Do projections still read transcripts**, or only KB transactions?
6. **Is the knowledge chat the curator?**
7. **Backfill** existing chats — and at what cost?
8. **Read-only projections**: should chat agents be told (or prevented from)
   editing OVERVIEW.md/CHANGELOG.md once `kb_note` exists?

## 14. Phasing and pilot

1. **Ledger only** (no LLM): capture mentions from every chat, retain blobs,
   expose a raw per-project timeline and `kb_search` over FTS5. Already answers
   "what did we exchange, and where".
2. **Curator**: items, topics, versioning, op log; the Knowledge tab.
3. **Projections**: move OVERVIEW/CHANGELOG onto KB transactions; `kb_note` as
   the sanctioned write path for chat agents.
4. **Optional**: embeddings, link refresh, cross-project hoisting, a knowledge chat.

**Pilot**: Ed's current multi-chat work sub-project (a parent chat plus five
children, several dozen resources). Ed writes a ground-truth list of the
resources he believes exist, and we measure capture recall, dedupe and version
accuracy, placement, and whether a *fresh* chat answers "where's the latest X
spec?" better than a no-KB baseline.
