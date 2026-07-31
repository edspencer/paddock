# Docs update runbook

How to bring `website/` (and `README.md`) back in line with the code after a
batch of releases. This is written for an agent working on the Paddock dev box,
but the shape holds anywhere.

Run this whenever the docs site has fallen behind. It has been run at v0.46.0
(a large backlog), v0.52.0 (six releases) and v0.53.0 (a single release); keep it
updated as the process changes.

---

## 0a. Scale the process to the delta

Most of what follows was written for a **multi-release backlog** and is overkill
for one minor release. For a **single-release delta**, the whole job is a couple
of hours and usually **one PR**. What changes:

| Step | Backlog (4+ releases) | Single release |
|---|---|---|
| 1. Ground truth | Full per-page last-touch map | Confirm version + read the two changelog sections |
| 3. Audit | Fan out 4 subagents over page groups | **Skip the fan-out.** Grep the site for the specific doc contracts the release touched |
| 4. Plan | One PR per doc area | One PR; two only if screenshots want separating |
| 5. Screenshots | Demo rig, seeded, multiple shots | Only if the release has a genuinely visual change — and see the observability check below |
| 9. Delegation | Fan out to child chats | Don't. Do it inline |

The steps that **never** scale down, because each has cost a real plan:
**checking for in-flight PRs first** (§1), **verifying the changelog against
source** (§3), and **branching + committing before any real work** (§9).

Deriving the doc-contract list (§2) and then grepping the site for each item is
the whole audit at this scale. It is also often a fast negative: at v0.53 three
of the release's four wire changes (`created`, `sweeperDefault`, the `target`
WebSocket alias) turned out never to have been documented, so their removal was
zero doc work. **Record the negative explicitly in the report** — "the site never
documented this" is a finding, not an absence of one, and it stops the next pass
re-checking the same ground.

---

## 0. The shape of the job

Docs drift is **not uniform**. Some pages are updated by the PR that changed the
behaviour; others rot for ten releases. The single most common failure mode is
assuming a blanket "the docs are stale since X" and rewriting pages that were
already correct — or, worse, trusting a page that looks recent.

So: **audit per page, verify against source, then plan.** Never plan from the
changelog alone.

---

## 1. Establish ground truth

**Run every `gh` command from inside a checkout of the repo you mean.** `gh`
resolves the repo from the cwd's git remote, and on this box the Paddock
*project* directory is part of the `edspencer/projects` notes repo, not the code
repo. Running `gh pr list` there returns `projects`' PRs — which at v0.53 was an
empty list, i.e. a silent, plausible wrong answer that would have hidden all five
open PRs. Clone first, then `cd` into the clone, and confirm with
`gh repo view --json nameWithOwner`.

```bash
# What is actually released?
gh repo view --json nameWithOwner -q .nameWithOwner        # never bare `git remote -v` (embeds the PAT)
git fetch origin --tags -q
git tag --sort=-creatordate | head -15
git show origin/main:package.json | grep '"version"'
```

Then find how far behind the docs are. The What's New page is the best marker —
its top entry names the last documented release:

```bash
head -40 website/src/content/docs/whats-new.md
```

And get a per-page last-touch map, which tells you which pages were maintained
along the way:

```bash
for f in $(find website/src/content/docs -name '*.md*'); do
  echo "$(git log -1 --format='%ad' --date=short -- $f) $f"
done | sort
```

> A recent date does **not** prove a page is current, and an old date does not
> prove it is stale. It only tells you where to look first.

### Check for in-flight work BEFORE planning

Do this early. It has already invalidated half a plan once:

```bash
gh pr list --state open --limit 20 --json number,title,files \
  -q '.[] | "#\(.number) \(.title) — \(.files | length) files"'
gh issue list --state open --limit 20 --search "docs OR website"
```

For any open PR, get the **full** file list (`gh pr view N --json files -q '.files[].path'`)
— a truncated listing will hide the overlap. At v0.52 an open 89-file PR was
already rewriting 15 of the pages the audit had just flagged, and two issues
already described most of the findings.

Then either sequence behind that PR or carve your scope around its file list,
and tell every child chat which files are off-limits. Two branches editing
different lines of one file usually merge, but a docs rewrite is not a
line-level change — assume conflict.

**When the overlap is one file you cannot avoid, look at *where* in it the other
PR edits before giving up.** File-level overlap is not always real overlap. At
v0.53 the open 89-file PR #558 touched `whats-new.md` — the single page the pass
existed to update — but its edit was a three-line amendment deep inside the 0.50
section, while the new work was a fresh `## 0.53` heading at the top plus the
frontmatter. Different regions of one file, no conflict:

```bash
gh pr diff <N> > /tmp/pr<N>.diff              # may be a "binary file" to grep; use grep -a
grep -a -A30 'diff --git a/path/to/file' /tmp/pr<N>.diff
```

Note the `-a`: a large diff frequently trips ripgrep/grep's binary heuristic and
the match is reported without the content.

If existing issues already describe the findings, reference them from the PRs
and let them close, rather than filing duplicates.

**Work in a fresh full clone**, not the in-place checkout (which is usually
parked on someone else's branch):

```bash
gh repo clone edspencer/paddock /data/projects/clones/paddock-docs-<ver>
```

Do **not** use `--depth`: a shallow clone implies `--single-branch`, and
`gh pr create` then fails even though the push succeeded.

---

## 2. Read the changelogs for the delta

Per-package changelogs, newest first:

- `packages/server/CHANGELOG.md`
- `packages/web/CHANGELOG.md`

There is no root changelog — this repo uses changesets. Locate the version
sections and read every entry in the delta range:

```bash
grep -n '^## ' packages/server/CHANGELOG.md | head -20
```

Read them **in full**. Paddock's changelog entries are unusually detailed and
carry the reasoning, which is exactly what a good What's New entry needs. They
also frequently bury the doc-relevant fact (a new env var, a removed route, a
renamed screen) in the middle of a paragraph.

While reading, keep a running list of anything that is a **doc contract**:

- new / removed / renamed **env vars** and **config keys**
- new / removed / renamed **HTTP routes** (especially breaking removals)
- new / removed **MCP tools**, or changed tool arguments and defaults
- **renamed UI surfaces** (screens, tabs, buttons, URLs)
- **retired concepts** — these are the worst offenders, because they are
  referenced in passing across many pages rather than in one place

---

## 3. Audit, in parallel, against source

Fan out subagents over disjoint page groups. A grouping that has worked twice:

1. `concepts/` + `architecture/`
2. `configuration/` + `reference/`
3. `using/` + `guides/` + `getting-started.md` + `index.mdx` + `contributing*`
4. `README.md` + repo `docs/` + site structure (`astro.config.mjs`)

Give each agent the delta list from step 2 and this instruction, which is the
part that matters:

> Establish ground truth from the actual source in `packages/server/src` and
> `packages/web/src`. Do not trust the changelog. Report every stale claim as
> `file:line`, with the correct statement and the source `file:line` that
> proves it. If you cannot verify something from source, say so explicitly
> rather than guessing.

Retired concepts are best found with a direct grep sweep as well, since they
hide in prose:

```bash
grep -rni "scratch\|one-off\|__root\|Inbox" website/src README.md
```

---

## 4. Turn the audit into a plan

Group findings into PRs that are independently reviewable and independently
revertable. What has worked:

- one PR per **doc area** (concepts, configuration, reference, using/guides)
- **What's New separately**, because it needs the demo rig and screenshots
- **new pages** separately from edits to existing pages
- **README** separately from the site

Two rules learned the hard way:

- **Docs-only changes get no version bump and no changeset.** They ship on the
  next release.
- **A doc that is right and code that is wrong is a finding, not a doc edit.**
  File it as an issue and say so in the report. Do not quietly "fix" the docs to
  match a bug. (At v0.46 this surfaced a wrong security model in
  `architecture/overview.md`; at v0.52, check anything describing a hard
  structural guarantee.)

---

## 5. Screenshots: spin a demo instance

The What's New page always carries screenshots of the new UI. Never screenshot
production — it contains real transcripts and private project names.

### First: can the feature actually be observed?

Before building a rig, **prove from source that the state you intend to shoot is
reachable in the browser**. A feature can be correctly implemented, fully tested,
and still never render in the situation you want to photograph — at which point
the rig is wasted and, worse, you may "fix" the screenshot by staging something
the user will never see.

At v0.53 the release's headline change was a badge on the sidebar's Home link
with two halves. The unread half is folded from the `GET /api/projects` response
and paints on first load. The in-flight half is folded from `chat:active`
WebSocket broadcasts — and nothing in the app opens that socket until a chat pane
subscribes (`ChatClient.subscribe` is its only caller; `ensureLive` returns early
while `subs.size === 0`). So on a freshly-loaded Home with turns genuinely
running there is no spinner to photograph, and no amount of seeding produces one.
This is the same defect as the already-open issue #573, inherited by a second
feature — which is itself the lesson: **when an issue says a signal never arrives,
every later feature reading that signal has the bug too.** Search for other
consumers before assuming the blast radius is one component.

The check is cheap. For each visual claim, trace: what populates this state, and
does the page I'm shooting cause that population? If the answer is "another
component does", the screenshot is a lie waiting to happen.

Two follow-ons when this bites:

- **Shoot the half that works** and say so in the entry. What's New can describe
  a known gap in one bolded sentence; the page already does this for superseded
  addresses, and an entry that quietly promises a spinner nobody will see is
  exactly the "docs teach behaviour the code lacks" failure this process exists
  to catch.
- **Report the finding upward and comment on the existing issue** rather than
  filing a duplicate — but do add the new consumer and any *new* corollary you
  found. At v0.53 the corollary was worse than the missing spinner: because the
  "is it running?" set is empty on a fresh load, the guard meant to stop a
  running chat counting as unread doesn't fire, so a chat that is running right
  now can be counted as **unread** instead. A missing indicator is a gap; a wrong
  one is a bug.

### Where things live on this box

The box moved off `/var/lib`; trust the environment, not the docs:

```bash
echo "$PM_REGISTRY $PM_SCRATCH_ROOT"     # → /data/paddock-servers/...
```

Rig scripts go under `$PM_SCRATCH_ROOT/<name>/`; the code is reached via
`--cwd`, which is not scanned by `pm`'s production-data guard.

### Launch

`pm start <name> --cwd <dir> -- <cmd>` splits `<cmd>` on whitespace, so anything
with env vars or quoting needs a **wrapper script**:

```bash
# /data/paddock-servers/<name>/serve.sh
export PADDOCK_DATA_DIR="$RIG/data"
export PADDOCK_AUTH_MODE=none
export PADDOCK_DANGEROUSLY_ALLOW_OPEN=1   # required since v0.44's bind guard
export PADDOCK_OPENAPI_ENABLED=1
export PATH="$CLONE/test/bin:$PATH"       # the fake `claude` stub

# The fake claude is a CLI stub, so turns MUST run on the batch runtime.
# The default is `session` (SDK runtime + its own bundled claude), which
# ignores PATH and dead-ends on "Not logged in". This box also EXPORTS
# PADDOCK_KEEPER_DRIVE_MODE=session, so pin it explicitly.
export PADDOCK_KEEPER_DRIVE_MODE=batch

# SCRUB INHERITED CREDENTIALS AND BRANDING. `pm` copies the whole host env and
# deletes only five data-path vars — see the comment in scripts/pm, which says
# tokens are deliberately not stripped. A rig is published on a dev subdomain
# that BYPASSES Authentik, so it must not carry this instance's identity.
# See paddock#567.
for v in $(env | cut -d= -f1 | grep -E '^PADDOCK_MCP_TOKEN_'); do unset "$v"; done
unset GH_TOKEN GITHUB_TOKEN
unset PADDOCK_AUTH_JWKS_URL PADDOCK_WHISPER_ENDPOINT PADDOCK_DEV_SERVERS_DOMAIN
unset PADDOCK_BRAND_NAME PADDOCK_BRAND_LOGO   # else the rig renders as THIS instance
```

The branding vars are the useful canary: if a rig's sidebar shows this box's
branding rather than stock Paddock, the environment was inherited wholesale and
a credential is in there too.

**Prove you are talking to your own instance before you believe anything.** `pm
status` reporting `online` and `/api/health` returning `200` are both satisfied
by a *stale squatter* on the same port. This has already caused one seeding run
to write into the wrong instance:

```bash
ss -lptn "sport = :$PORT"
tr '\0' '\n' < /proc/<pid>/environ | grep PADDOCK_DATA_DIR
```

### Seed data

**Disable curation before you seed, not after.** The rig runs a real keeper, so
a completed turn enqueues a sweep — and the sweeper replaces `OVERVIEW.md` and
`CHANGELOG.md` wholesale. With a fake `claude` behind it, that means your
carefully written demo `OVERVIEW.md` gets overwritten with a generic stub
somewhere between seeding and shooting. Set a disabled `curate-overview` trigger
on every workspace first:

```yaml
triggers:
  curate-overview:
    trigger: { type: event, on: afterTurn }
    enabled: false
```

Drive a seed script over the REST + WS API rather than hand-clicking: create a
few projects with plausible names, run chats through the fake-claude fixture map
(`PADDOCK_FAKE_SCRIPT`, a prompt→reply JSON map), then star / unread / pin a few
so the UI has texture.

Use **fictional** project names and content. Strip the fake harness's directive
tokens (`[[TOOL]]`, `[[BOUNDARY]]`, …) from transcripts afterwards, or they show
up in the screenshots.

### Capture

Use Playwright MCP against the rig's own URL — on a box with per-port dev
subdomains that is `https://<port>.<your-dev-domain>/`. Take the port and host
from `pm status`, never from a hard-coded value in a document.

- Write captures to `.playwright-mcp/` (gitignored). **`qa/` is NOT gitignored**
  despite what the box `CLAUDE.md` says — files written there are tracked forever.
- Never let a capture land in the project root — Playwright puts explicitly-named
  files in the cwd. Pass the directory explicitly:
  `filename: ".playwright-mcp/whatsnew-sidebar.png"`. A bare filename lands in
  the tracked project root.
- **`.playwright-mcp/` is NOT per-chat.** Every chat in a project shares the
  project directory as its cwd, so they all write captures into the *same*
  `.playwright-mcp/`. **Prefix filenames with the job** (`whatsnew-*`). Without
  that, a capture you did not take looks like proof of a rogue concurrent
  worker — which is exactly how one session lost time to a false alarm.
- The rig's Home pane footer prints `Project directory: <the rig's data dir>`.
  It is a bare `<span>`, so a naive text match misses it; match the element
  whose children don't also match, and set `visibility: hidden` before shooting.
- **Check every screenshot for leaks before committing**: rig URLs, `127.0.0.1`,
  LAN IPs, your instance's own hostname or branding, real project names. Hide an
  offending element with `browser_evaluate` and re-shoot rather than cropping.
- **`strings foo.png` is NOT a leak check.** Rendered text is pixel data, not
  bytes — a PNG showing a live token greps clean. Scan the *page's text nodes*
  before shooting, and then **actually look at the committed image**. Both, every
  time.
- Frame tightly on the feature. Resize the viewport to suit; a full-page
  screenshot of a wide window makes the subject unreadable in the docs column.

Committed screenshots go in `website/src/assets/whats-new/` and are referenced
with a relative path and real alt text:

```markdown
![The per-message hover rail on an assistant reply, showing its age and the context-window fill at that point](../../assets/whats-new/per-message-hover.png)
```

---

## 6. Writing What's New

House style, derived from the existing page:

- **Newest release first**, `## 0.NN — <short thematic title>`.
- Bullets lead with a **bold sentence naming the user-visible change**, then
  prose explaining what it replaced and *why it is better* — not the
  implementation.
- Write about what a user will **notice**. The changelog explains the mechanism;
  What's New explains the experience.
- Keep the frontmatter `description` current — it is a running em-dash-joined
  list of features, newest first.
- Each entry describes the release **as it shipped**. When a later release
  supersedes it, do not rewrite history — the `:::note[Reading older entries]`
  aside at the top of the page exists to cover exactly that, and should be
  extended when a new supersession happens.
- The editorial paragraph near the top draws the thematic arc across the recent
  stretch. Update it when the arc genuinely changes.

---

## 7. Verify before opening the PR

Starlight does **not** auto-discover pages — the sidebar in
`website/astro.config.mjs` is hand-maintained. A new page that is not added
there is invisible.

```bash
cd website
env -u NODE_ENV npm install          # the box exports NODE_ENV=production,
env -u NODE_ENV npm run build        # which silently prunes devDependencies
```

Check all four:

1. **Build exits 0** and the page count matches expectation.
2. **No orphans** — every page file appears in the sidebar.
3. **No dangling** — every sidebar entry resolves to a real page.
4. **No leaks** — grep the built site, `website/`, and anything else in the diff
   for your instance's hostname and dev-subdomain suffix, LAN IPs, `127.0.0.1`,
   and any rig hostname. **This applies to prose you are adding as well as to
   screenshots.** This runbook itself failed that check on its first commit: it
   is written on a private box and named that box's dev domain in three places,
   which is fine in a scratch clone and not fine in a public repo. Write
   box-specific values as placeholders and tell the reader where to look the real
   one up.

Also confirm internal links resolve. Starlight will build happily with a broken
relative link.

---

## 8. Ship

- Branch per PR; never force-push.
- Docs-only ⇒ **no changeset, no version bump**.
- Let CI run: typecheck, E2E, docs-site build, secret scan. CI is the backstop
  that has caught real problems every time.
- Merge, then **verify live** — the site is Cloudflare Pages (root dir
  `website`, `npm install && npm run build`, domain `paddock.edspencer.net`).
  Curl the new and changed URLs for `200`, and check any published spec is
  stamped with the current version.

### Cleanup

- Delete each PR's clone once merged.
- `pm rm <name>` the demo rig and remove `$PM_SCRATCH_ROOT/<name>/`.
- Delete scratch captures.

---

## 9. Delegating to child chats

If you fan the PRs out to child chats, be explicit and expect to be ignored
anyway:

- Tell each child its **exact scope**, and that it must **establish ground truth
  from source first**.
- **Make branching and an empty commit the literal first step.** At v0.52 all
  four children hit a session limit mid-task and *none* had committed anything;
  one was about to commit onto `main`. Work in progress is invisible to you and
  one lost session from gone. Tell them to branch first and commit incrementally.
- **Order long jobs so the cheap value banks first.** The What's New child was
  told prose-first, screenshots-second: five release entries need no demo rig, so
  a second session limit costs nothing instead of everything.
- **Re-verify a child's findings before acting on them.** One child reported the
  `Dockerfile` citing the same issue number for two unrelated fixes; the issue
  turned out to cover both. The report was careful and still wrong.
- State plainly: **do not merge your own PR** and **do not spawn other chats**.
  At v0.46, six of nine children self-merged and one took over coordination
  regardless. CI held every time, so quality survived — but plan to verify
  post-hoc rather than trusting compliance.
- Give each child a **distinct clone path**. Two children sharing a clone path
  raced and one committed into the other's tree.
- Have children report findings back rather than acting outside their scope.
  Minor code-vs-docs findings: report and continue. Major: stop, and say so.
- **A single session can run two agent processes at once.** They share the
  session's brief, its clone and its scratch dir, and will duplicate each
  other's work — one re-fired a `[[HANG]]` turn to retake a screenshot the other
  had already taken. Diagnose it from `/proc`, not by inference:

  ```bash
  for p in <pid> <pid>; do
    [ -d /proc/$p ] && echo "$p alive cwd=$(readlink /proc/$p/cwd)" || echo "$p gone"
  done
  ```

  Do **not** run destructive cleanup while you suspect a concurrent actor — a
  `pm rm` plus `rm -rf` of the rig would destroy in-flight work you cannot see.
  Establish who is running first, then decide.
- **Push early so duplication is survivable.** The one child that had already
  pushed its prose to a draft PR lost nothing to a duplicated process; the value
  was in git before the race started.
