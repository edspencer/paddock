# Docs update runbook

How to bring `website/` (and `README.md`) back in line with the code after a
batch of releases. This is written for an agent working on the Paddock dev box,
but the shape holds anywhere.

Run this whenever the docs site has fallen behind. It has been run at v0.46.0
(a large backlog), v0.52.0 (six releases), v0.53.0 (a single release), v0.55.0
(three releases, with video), v0.62 (a systematic pass, #703) and v0.66.2 (the
What's New backfill + archive split, #762, and the `docs/` triage below); keep it
updated as the process changes.

> This file used to live at `docs/DOCS-UPDATE-RUNBOOK.md`. It moved to the repo
> root because `docs/` is largely a superseded fork (see [`docs/README.md`](docs/README.md)),
> and a live contributor process should not share a fate with it. It belongs with
> `CONTRIBUTING.md`, `DEV.md` and `RELEASING.md`.

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
| 5. Media | Demo rig, seeded, multiple shots, a recorded clip for the headline | Only if the release has a genuinely visual change — and see the observability check below |
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
head -40 website/src/content/docs/whats-new.mdx
# older entries now live in whats-new-archive.mdx (split in #762)
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


**Re-check PR and issue state at the moment you act on it, not when you plan.**
Several agents work this repo concurrently, so the recon in this section has a
short shelf life — measured in hours, not days. On the v0.69 pass a PR landed
mid-pass and closed three issues an audit had re-verified as open only shortly
before. Anything you decided from that snapshot — an off-limits file list, a
"still open, worth documenting" ruling, a plan to file an issue — can be false by
the time you execute it, and the failure is silent in both directions: you either
document a gap that has just been filled, or file a duplicate of something that
closed while you were writing it.

The re-check is one command each, so run them again immediately before you edit,
not once at the top of the pass:

```bash
gh pr view <N> --json state,mergedAt -q '"\(.state) \(.mergedAt // "-")"'
gh issue view <N> --json state,stateReason -q '"\(.state) \(.stateReason // "-")"'
```

Note that an issue closed as `NOT_PLANNED` or as a duplicate is **not** an issue
that was fixed — the defect it describes may still be live, and a docs page must
not start promising otherwise. Check `stateReason`, not just `state`.

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
3. `using/` + the **non-security** `guides/` (who-its-for, deploying,
   dev-box-flavor, proxmox-lxc, kubernetes, connect-claude-code, home-lab)
   + `getting-started.md` + `index.mdx` + `contributing*`
4. **Security** — `guides/{securing,what-paddock-touches,agent-capabilities,untrusted-content}`
   + `configuration/{authentication,binding-and-exposure}`
5. `README.md` + repo `docs/` + site structure (`astro.config.mjs`)

Group 4 is defined by **the sidebar, not the directory tree**: the Security group
(`website/astro.config.mjs`, the `label: 'Security'` block) deliberately cuts
across `guides/` and `configuration/`. Splitting it by folder hands one reviewer
half a security story. Check the sidebar before reusing this grouping — it has
changed once already.

`whats-new.mdx` / `whats-new-archive.mdx` stay **out** of the fan-out; they are
§6's job and every agent will otherwise touch them.

Give each agent the delta list from step 2 and this instruction, which is the
part that matters:

> Establish ground truth from the actual source in `packages/server/src` and
> `packages/web/src`. Do not trust the changelog. Report every stale claim as
> `file:line`, with the correct statement and the source `file:line` that
> proves it. If you cannot verify something from source, say so explicitly
> rather than guessing.

### Verify a survey agent's NEGATIVE findings before acting on them

A survey agent's most dangerous output is not a mistake about what the code does
— it is a confident claim about what the code **does not** do. "The changelog
says X is enforced; source shows it is not" reads as exactly the rigour you asked
for. It is also the one kind of finding whose consequence is **deleting or
watering down correct documentation**, and unlike a false positive nothing
downstream catches it: the edit makes the docs claim *less*, so it builds, reads
sensibly, and survives review.

In the v0.69 pass an audit reported an accessibility floor as unenforced. Source
showed the enforcement was real and shipped. Three child chats were briefly
steered into under-claiming a feature that worked, on the strength of one
sentence in a report. The residue that *was* true turned out to be far narrower
than what had been reported.

**Before running a check, ask what result would falsify the claim. If no result
would, you are not verifying — you are collecting agreement.**

This is the mechanism underneath everything else in this section, so apply it
first. Three separate errors in the v0.69 pass shared exactly this shape: an
accent-contrast finding accepted without opening the file; a "which PR carries
the runbook corrections" judgement made from marker counts rather than a diff;
and an attribution claim settled by a same-minute mtime, which fits "two agents
racing" and "two agents working independently" equally well and so could not
have come out the other way. In each case a discriminating check existed and was
cheap — read the source, diff the branches, `find` the artefacts. The tell is
that a corroborating check feels like confirmation and costs nothing, which is
precisely why it gets run instead.

**An attribution claim is a negative finding about everyone else.** "Agent B did
this" implicitly asserts "agent A did not", so it needs artefact-level proof: a
branch, a worktree, a pushed commit that *names* an actor. A shared mtime is
correlation, not proof — and on a box where every agent commits under one
identity, the author field cannot discriminate either. Acting on a weak
attribution is the most expensive version of this mistake, because it cancels
another agent's work rather than merely producing wrong prose.

So, for any negative finding:

- **Open the source and confirm the absence yourself** before a single word of
  docs changes. An absence needs the same `file:line` evidence a presence does —
  the line that *would* enforce it, and does not.
- **Scope it to its narrowest defensible form.** "Not enforced" and "not enforced
  on this one code path when the value is user-supplied" get the same nod in a
  report and lead to completely different edits. Write the narrow one.
- This matters most **in a filed issue**: an over-broad negative sitting next to
  a true one discredits the true one. A maintainer who disproves your first
  sentence has no reason to trust the second.
- **The rule binds the corrector too.** A correction to a negative finding is
  itself a claim, and needs the same source read before it is sent. On the v0.69
  pass both errors happened within an hour and in opposite directions: a survey
  agent reported the accent picker's AA floor as unenforced — false, because
  `solve()` bounds its search so it never returns below `floor`, and
  `repairFill` repairs `--accent-solid` to the 4.5 text floor — and the
  correction to that report over-swung into "nothing is enforced", which is
  false in the other direction. Neither party had opened `accent.ts`. The
  narrowest true form was available to both and is more useful than either: the
  floor is enforced, but nothing *verifies* it — `solve()` returns a `hit` flag
  every caller discards, the computed `ok`/`checks` report is never rendered,
  there are no solver tests, and `--accent` targets the 3:1 non-text mark floor
  rather than 4.5. A reviewer is the person most likely to feel exempt from this
  rule and is the one it exists for: correcting a claim feels like restoring the
  truth, which is exactly why an unverified correction travels further than the
  error it replaced.

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

## 5. Screenshots and video: spin a demo instance

The What's New page always carries screenshots of the new UI, and a genuinely
visual headline feature is worth a short recording. Never shoot production — it
contains real transcripts and private project names.

### ⛔ First, prove you are not shooting a stale build

**This is the failure that costs the entire pass, and every other check still
passes while it happens.** A rig serves `dist/` from some checkout. If that
checkout predates the release you are documenting, every "re-shot" frame is the
**old UI again** — and nothing tells you: the rig comes up, the seed passes, the
leak scan passes, all shots succeed, `md5sum` shows no duplicates. The only tell
is a design nobody examines twice while concentrating on framing. A reviewer
notices weeks later that the new screenshots look exactly like the old ones.

Rebuilding the rig's checkout is necessary but **not sufficient as evidence** —
it proves the git state of a directory, not what the server is actually serving.
Prove it from *inside the running rig* instead:

> **Name a UI element that only the new build can paint, then go and look at
> it.** One navigation, unambiguous, and it tests the served bundle.

Pick the element from the release's own headline change — something structurally
new, not merely restyled, so it cannot be mistaken for the old build under a new
coat of paint. At the design release this was `/config` → the **Appearance**
section with its four theme cards, which cannot render on any build before the
theme commit landed. A cheap pre-check is to grep the served JS bundle for a
string literal only the new build contains, **with a negative control**: grep for
a value you know is absent (a cut feature's name) and confirm it returns nothing,
or you have only proved your grep works, not that the build is new.

**Better still, prefer a freshness check whose evidence survives *in the captured
frame*.** Paddock's sidebar footer carries the running version, so a committed
screenshot proves which build served it — permanently, legibly, and without
re-running anything. The v0.69 stills read `v0.69.0` in the footer, which is why
"was this shot against the redesign?" stayed answerable long after the rig was
gone. A navigation check is better than nothing, but it is a **claim about a past
action**: it proves the build was current at the moment someone looked, and
anyone auditing later has to take that on faith — exactly the kind of claim this
runbook says not to accept elsewhere. In-frame evidence needs no faith.

Belt and braces is to have both, because they fail differently: the in-frame
stamp survives forever but only exists where the chrome is in shot (an element
crop of a dialog has no footer), while a capture-time sidecar (see
`tools/docs-media/`) records the version for *every* shot including tight crops,
but is a separate file that can be lost or go stale against the image.

**What happened when this was actually run (v0.69).** The check **passed first
time** — but only because the hazard had already been removed, and the sequence
is the point. The rig's existing checkout *was* stale: parked on its own branch
at the previous release's baseline, comfortably pre-redesign. Restarting that rig
would have produced a full set of plausible, leak-clean, duplicate-free frames of
the **old UI**. Instead the pass built a fresh checkout at `main` first and
pointed the rig at that, so by the time `/config` was opened the Appearance
section was there and the check merely *confirmed* a mitigation rather than
catching a mistake.

Read that as the check working, not as the check being unnecessary. Two things
follow for the next pass:

- **Verify the rig's checkout ref before you serve it**, not after. `git log -1`
  in the rig's clone is a second of work and is what actually decides this; the
  in-browser check is the evidence that the decision took effect.
- **A rig clone parked on an old branch is the normal state, not an anomaly.** It
  is left wherever the previous pass abandoned it, months earlier, and nothing
  about a rig that comes up healthy suggests otherwise. Assume stale and prove
  current.

### A release that changes the DESIGN: bucket by tense, not by directory

The hardest judgement in a docs pass is not which images are old. It is which old
images are *wrong*, and the answer is not the same thing:

> A **What's New entry is a record of a release.** Its screenshot is evidence of
> what shipped on that date, so an old-UI frame there is **correct**. Replacing
> it does not make it more accurate — it makes it false, because it asserts that
> an old release looked like today. An archive of undated claims about the
> present is the one thing an archive must not be.
>
> A page in `using/`, `concepts/`, `configuration/`, `reference/` or `guides/`
> makes the opposite claim: *this is what you will see when you open Paddock.* An
> obsolete frame there is simply wrong, and worse than no image — a reader who
> cannot find the pictured control concludes the docs are stale everywhere.

So: **bucket by the tense of the surrounding prose, not by the directory the file
lives in.** Directory is a proxy, and it fails on exactly the assets that matter.

Two corollaries worth stating so nobody re-litigates them:

- **Age is not the criterion.** At the design pass, three of the must-re-shoot
  stills were a *day* old. They were stale because of what merged 41 minutes
  after they were committed, not because of when they were taken. Check the
  commit *times* against the design commits, not the dates.
- **The dual-use assets are the whole judgement call.** An asset cited from
  *both* a current-behaviour page and an archive entry cannot be both a correct
  historical record and a correct picture of today. **Fork it:** shoot a new
  frame into the owning section (`src/assets/using/…`), repoint *only* the
  current-behaviour reference, and leave the `whats-new/` copy byte-identical.
  Cost is ~10 KB and one changed line each; the benefit is that both claims
  become true at once, which neither re-shooting in place nor leaving it alone
  achieves. "Duplicate assets are a smell" is the wrong smell here — these are
  two different assertions that merely shared a file while the UI was stable, and
  the redesign is precisely the event that separates them.

Add one line under the What's New intro rather than touching the historical
images — *"Screenshots show each release as it shipped; the UI was redesigned in
0.NN."* That costs a sentence and defuses every "these look old" report.

### The rig must be reproducible from the repo

**This is now the weakest link in the whole workflow.** A rig whose launcher and
seed exist only on one box is one container restart from being undocumented, and
the failure is not a clean one.

The specific incident, because the shape of it generalises: the rig's
`PADDOCK_PROJECTS_DIR` pointed under `/home`, which on that box was **never a
persisted volume** — the persistent one was mounted elsewhere. A container
restart destroyed the entire projects tree (every `project.yaml`, every
`.chats/*.jsonl`, every seeded fixture) while the **data dir survived**. That
asymmetry is the dangerous part: the instance boots happily to *zero projects
plus orphaned job records*, so chat counts and unread badges reference
transcripts that no longer exist. It does not fail; it lies.

Rules that follow:

- **Put the projects root on the box's persistent volume**, and confirm which
  volume that is from the environment rather than from any document.
- **Wipe the projects tree and the data dir together, or neither.** Wiping one is
  what manufactures the orphaned-record state.
- **Commit the launcher and the seed to `tools/docs-media/`**, parameterised by
  environment variables, so the next pass stands the rig up with one command
  instead of re-deriving it. Keep box paths, ports and domains out of the
  committed copy — this repo is public.
- **Never `cat` a rig launcher.** Several hold a real OAuth token in plaintext;
  reading one copies it into your own transcript permanently, and that transcript
  is itself a file the next rig copy picks up. Write the sanitised version from a
  spec rather than copying and editing — a copy keeps the token in the editor
  buffer and in shell history. Use `grep -c`, or `grep -v` the secret lines.

A cosmetic trap worth knowing before you design around it: **Paddock canonicalises
the projects root for display.** Symlinking a pretty fictional path at the real
storage location does *not* buy you a pretty path on camera — the UI resolves the
symlink and shows the real one, which the leak masker then hides, leaving a blank
where the path should be. If the on-camera path matters, the projects root has to
*really* be at the presentable path.

### Video: ship MP4 not GIF

**There is no video-production harness in this repo, and there is no `video/`
directory.** The experiment behind #584 was dropped and that PR closed; the eight
orphaned files it left under `video/videos/` — which imported a `video/lib/` that
was never on `main`, so they could not run from a fresh clone — were deleted in
#842. Do not plan around a harness, and do not go looking for `video/README.md`
or `lib/cinematics.mjs`: neither has ever existed here.

If you need to record a clip, write the capture yourself with Playwright's
`recordVideo`, and budget for the one non-obvious constraint the experiment did
establish: Playwright's real pointer is **not** captured by the screencast, so a
recording without a drawn synthetic cursor looks like a ghost is driving the UI.

What *is* on `main`, and is the thing you actually ship through, is the
`DemoVideo` Astro component (`website/src/components/DemoVideo.astro`). The
measurements below still hold.

**Ship an MP4 through the repo's `DemoVideo` component, not an animated GIF.**
This is already settled and the component's header carries the measurements. On
the 0.55 import clip: **274 KB of MP4 against 2.0 MB for the equivalent GIF**,
and the GIF loses small UI text — tool names, timestamps, counts — to 256-colour
dithering. `DemoVideo` configures the video to *behave* like a GIF (muted,
autoplay, loop, playsinline) while keeping controls, a poster frame, and an
inline script that honours `prefers-reduced-motion`, which CSS cannot do for a
video. If someone asks for "a GIF", give them this — it is the same experience,
smaller and readable.

Two mechanical consequences:

- `DemoVideo` is an Astro component, so the page must be **`.mdx`**. `whats-new`
  is **already** `.mdx` (renamed in `2751b92`), as are `whats-new-archive.mdx`
  and `using/reading-claudes-work.mdx`. Starlight routes `.md` and `.mdx` to the
  same slug, so a rename never moves a published URL.
- **MDX is stricter than Markdown.** A JSX block placed immediately after a list
  item fails the build with `Unexpected lazy line in container` — it is read as a
  lazy continuation of the list. Put a blank line before every JSX block. Tables
  inside list items survive the conversion fine.

Media goes in two different places: **video and poster in `website/public/demo/`**
(referenced by absolute path, `/demo/foo.mp4`, and served as-is), **stills in
`website/src/assets/whats-new/`** (referenced relatively, and run through Astro's
image pipeline into `.webp`). Putting a video in `src/assets/` does not work.

Verify in a browser, not just in the build: load the page and check
`video.readyState`, `videoWidth` and `duration` are non-zero. Images below the
fold report `naturalWidth: 0` because they are lazy-loaded — that is not a
failure; curl the built `/_astro/*.webp` URLs to confirm they are really there.

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
# PADDOCK_DRIVE_MODE=session, so pin it explicitly.
export PADDOCK_DRIVE_MODE=batch

# SCRUB INHERITED CREDENTIALS AND BRANDING. `pm` copies the whole host env and
# deletes only FOUR data-path vars — PADDOCK_DATA_DIR, PADDOCK_PROJECTS_DIR,
# PADDOCK_STATE_DIR, PADDOCK_HERDCTL_CONFIG (scripts/pm, SCRUB_VARS, overridable
# via PM_SCRUB_VARS) — and the comment there says tokens are deliberately NOT
# stripped. A rig is published on a dev subdomain that BYPASSES the SSO proxy,
# so it must not carry this instance's identity. See paddock#567.
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

**Both of those fail if you are running inside a container**, which an agent on a
containerised box usually is. A container has its own network namespace and its
own PID view, so `ss` reports **no listening socket for a port that `curl`
answers on with a `200`**, and the server's pid may not be in your `/proc` at
all. Note the direction of the failure: it looks exactly like *"the rig isn't
running"* while the rig is running fine, which is the worst way for a check to
be wrong — you conclude the opposite of the truth and go rebuild something that
was never broken.

**Identify a rig from its API contents instead.** It works from anywhere that
can reach the port, needs no namespace access, and asks the instance what it
*is* rather than what is listening:

```bash
curl -s "$BASE/api/instance-config" |
  python3 -c 'import sys,json; c=json.load(sys.stdin)
f={x["key"]:x.get("value") for g in c.get("groups",[]) for x in g.get("fields",[])}
print(f.get("dataDir"), f.get("driveMode"))'
```

Assert on **`dataDir`** — unique to one rig — and on **`driveMode`**, because a
rig reporting `session` means the fake `claude` is being ignored and real credit
is being spent. Put that assertion in the seed script itself and let it refuse,
rather than leaving it as a step someone remembers. `pm status: online` and
`/api/health: 200` are liveness; neither is identity.

### Seeding from a COPY of production

Hand-seeded fixtures never look like a real instance: the chat volume is wrong,
every timestamp is "today", and the sidebar is too tidy. Copying production gives
you genuine density for free. **Copy — never symlink.** A symlinked `.chats` has
already cost real transcripts on this box, and the whole value of a copy is that
you may safely rewrite it.

```bash
rsync -a --exclude='node_modules/' --exclude='.git/' --exclude='clones/' \
      --exclude='wt-*/' --exclude='qa/' --exclude='.playwright-mcp/' \
      --exclude='dist/' --exclude='*.mp4' --exclude='*.webm' \
      /data/projects/ "$RIG/data/projects/"
# then the data-root sidecars, or history/provenance/read-state are all missing:
#   .herdctl/  attachments/  agents/  sweepers/  herdctl.yaml
#   {archive,read,unread,star,sweep}-state.json  {run,message}-provenance.json
```

Then disarm it: strip `triggers:` blocks and `repo:` keys from every
`project.yaml`, so nothing can fire on a schedule or reach a real repository.

**⛔ `CLAUDE_HOME` is GONE — isolate with `CLAUDE_CONFIG_DIR`.** #691 removed it
(`packages/server/src/config.ts`, `resolveClaudeHome`) and it is **ignored, not an
error** (`packages/server/test/unit/config.test.ts` — "ignores the removed
`CLAUDE_HOME` entirely"). So a launcher that still exports it silently falls back
to the default `<dataDir>/claude-home` **while you believe you isolated**. That is
the whole failure: it looks like it worked.

`CLAUDE_CONFIG_DIR` is the surviving override. Pointing it at a private directory
still discovers every copied chat (Paddock re-plants its
`<claudeHome>/projects/<encoded workingDir>` symlinks on boot) and keeps the rig's
transcripts, plus anything you stage, out of your own `~/.claude`. Paddock now
also **refuses to start** if its home resolves to `~/.claude` — a guard, not a
substitute for getting the variable right, because the ignored-`CLAUDE_HOME` case
resolves to the *default* and boots perfectly happily.

This matters more here than anywhere else in the runbook: on a box whose `$HOME`
is a shared account, `~/.claude` holds **real transcripts and a real login**, and
a rig that thinks it is isolated will adopt from and write to them. **Verify the
running process rather than the intent:**

```bash
tr '\0' '\n' < /proc/<pid>/environ | grep -E '^(HOME|CLAUDE_CONFIG_DIR|CLAUDE_HOME)='
```

#### Scan the copy for secrets BEFORE you record

Production transcripts contain credentials that agents pasted, printed or read.
On the 0.55 pass a copy of `/data/projects` carried **16 files with live tokens**
— seven Anthropic OAuth tokens and nine GitHub PATs — including *the transcript
of the very session doing the work*, because it had `cat`ed a rig launcher that
holds a token in plaintext.

```bash
grep -rlE 'sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}' "$RIG/data"
```

Two traps, both of which produce a confident zero:

- **`grep -E` with `\{20,\}` matches nothing.** Under ERE the braces are literal.
  The first sweep on this pass "found" 0 secrets in files that demonstrably had
  them. Use bare `{20,}` with `-E`, and sanity-check the pattern against a file
  you know matches.
- **Do not `cat` a rig launcher.** Several hold a real `CLAUDE_CODE_OAUTH_TOKEN`
  at `chmod 600`. Reading one copies it into your own transcript, which is then
  itself a file the next rig copy will pick up. `grep -c` for what you need, or
  read with the token line filtered out.

Scrub in place rather than deleting the chats — deleting leaves orphaned job
records and dents the density you copied the data for:

```bash
sed -i -E 's/sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}/sk-ant-REDACTED/g' "$f"
```

#### Fictionalise what will be on camera

Real chat *titles* are the revealing part — project names are usually already
public, but "Revive/kill <product>" is a business signal. You control the copy,
so fix it rather than leaving the judgement to the reviewer: rename via
`PATCH <base>/chats/:sessionId` with `{"name": "..."}` (use `/api/root` for root
chats, `/api/projects/<slug>` otherwise). Renaming the ~30 chats that appear in
the feed you are shooting takes one script and removes the question entirely.

Then re-shoot and **look at the frames**. The rig's Home footer prints its real
data directory; hide it before the first frame, and assert from the page that
nothing else leaks:

```js
document.body.innerText.match(/<your-domain>|127\.0\.0\.1|\/data\/scratch|sk-ant/g)
```

#### Staging a feature that has no data yet

For a feature like 0.55's chat import, the honest demo is a **fictional project**
— a repo you have just added, whose history is still in your terminal. That is
both the real use case and completely safe to publish. What the detection
actually requires (traced from source, and cheaper to know than to rediscover):

- `CLAUDE_CONFIG_DIR` is honoured (`CLAUDE_HOME` is **not** — #691), so stage
  into the rig's private home.
- The folder name is `encodePathForCli(cwd)` — every non-alphanumeric character
  becomes `-`. **The fake checkout directory itself need not exist.**
- A repo-backed project matches on the *checkout basename* of its `repo:` key, so
  keep `repo:` on the one project you are filming even though you stripped it
  everywhere else.
- Each transcript must be **≥ 256 bytes** and its first user message must **not**
  start with `/`, or it is filtered as noise.
- The adoptable cache is **in-process**; `touch` will not invalidate it. Restart
  the rig after staging.

### Seed data for a live-turn shot

**Disable curation before you seed, not after.** The rig runs a real agent, so
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

### Pin the appearance, before the page loads

Once the product has runtime themes, **a screenshot is no longer determined by
the URL** — it also depends on browser state, so a capture has to pin it or the
frames drift between runs and between operators.

Shoot the **out-of-the-box default** (at the design release: the neutral base
theme, dark, the theme's own accent, no tint). A docs screenshot's job is to
match the reader's screen on first boot, and pinning a named accent would
document one person's preference as the product's appearance. The one exception
is a shot whose *subject* is the choice itself — a theme quartet — where all four
belong.

Two mechanics, each with its own failure mode:

- **Write the keys with `addInitScript`, not `page.evaluate` after `goto`.** They
  are read by a **pre-paint inline script**, so writing them after navigation is
  too late: you get a flash of the wrong theme and, worse, a shot taken mid-swap.
  `addInitScript` runs before any page script, on every navigation.
- **Clear the solved-accent cache key.** It is keyed `<theme>:<mode>`, so a stale
  entry from a previous run paints the *previous* theme's accent before the app
  boots, and a fast shot catches exactly that frame.

Then **assert it applied** rather than trusting it — read the dark class and the
accent custom property off the document after the first navigation. Do *not* try
to verify a theme by grepping CSS or token strings: OKLCH serialises as
`oklch(...)` and the accent token is a bare space-separated RGB triple, so a
regex reader scores a correctly-themed build zero. If you need proof of a colour,
read the computed style or sample a rendered pixel.

### Seeding a rig with enough texture to photograph

A seed that creates *projects* is not enough: a **chat is the product of a turn**,
so an instance seeded purely by API calls photographs as an empty application.
Drive real turns through the fake `claude` (a prompt→reply JSON map, so the text
on camera is authored rather than improvised), then shoot.

Two things bite here:

- **Rename chats in a second pass, after every turn has finished.** Renaming
  immediately after a turn completes loses a race with the transcript's own title
  resolution, which lands afterwards and overwrites the custom name. The symptom
  is easy to misread: the chat ends up named the *prompt you sent*, so it looks
  like a name you chose badly rather than a write that was clobbered.
- **Check which mutations are their own route.** Some flags are not fields on the
  rename `PATCH` — a body key the schema does not declare is accepted and
  silently dropped, so the call returns `200` and nothing happens.

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
- **A detection pattern is content.** An early `capture.mjs` carried this box's
  private dev domain *inside its own leak-detection regex* — so the tool written
  to stop the string being published would have published it, in a public repo,
  on the first commit. Anything naming your machine goes in an environment
  variable (`$PADDOCK_LEAK_EXTRA`) that the committed file reads; the generic
  half — loopback, RFC1918, host path prefixes — is all that belongs in the file.
  This is the reason that variable exists, so say so wherever you document it.
- **Check every screenshot for leaks before committing**: rig URLs, `127.0.0.1`,
  LAN IPs, your instance's own hostname or branding, real project names. Hide an
  offending element with `browser_evaluate` and re-shoot rather than cropping.
- **`md5sum` the output before believing you have N shots.** Two *unframed* shots
  of the same URL at the same viewport are **byte-identical** — the difference you
  intend (which element you were pointing at) does not exist in the pixels unless
  you express it as a `selector`. This has already put a duplicate in a shots dir
  looking like two captures. Run
  `md5sum out/*.png | sort | uniq -D -w32` and require empty output, every run,
  not once. It matters most for a set that is *supposed* to look similar — four
  shots of one route in four themes is precisely that configuration.
- **Frame on the subject.** A scroll container is as tall as its *viewport*, not
  its content, so an unframed element shot of a four-row list comes out ~40% dead
  space and reads as a sloppy screenshot rather than a short list. Use a
  `selector`, plus a "clip at the bottom of the last matching child" helper.
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
- **A bug the release fixed in a previous entry is worth saying so.** When 0.54
  fixed the socket gap that 0.53's entry had disclosed, the 0.54 bullet said
  which earlier symptom it cured. That is the page being honest across time
  rather than each entry pretending to be the whole story.

---

## 7. Verify before opening the PR

Starlight does **not** auto-discover pages — the sidebar in
`website/astro.config.mjs` is hand-maintained. A new page that is not added
there is invisible.

```bash
cd website
npm install     # the website's build deps live in `dependencies`, NOT
npm run build   # devDependencies, precisely so a NODE_ENV=production install
                # still gets them (see the comment in .github/workflows/ci.yml).
                # `env -u NODE_ENV` is harmless but UNNECESSARY here — unlike the
                # server/web test suites, where it is still required.
```

`npm run build` fires `prebuild` (`website/scripts/copy-openapi-site.mjs`), which
copies `openapi-site/` into `website/public/api/`. That is what makes the
sidebar's "HTTP API (Swagger)" → `/api/` entry resolve; it hard-fails outside a
full checkout, and it is why `openapi-site/**` is in the docs CI path filter.

Check all four:

1. **Build exits 0** and the page count matches expectation.
2. **No orphans** — every page file appears in the sidebar.
3. **No dangling** — every sidebar entry resolves to a real page. Items 2 and 3
   are mechanical; run them rather than eyeballing the sidebar (from `website/`):

   ```bash
   node -e 'const fs=require("fs"),p=require("path");
   const c=fs.readFileSync("astro.config.mjs","utf8");
   const s=new Set([...c.matchAll(/slug:\s*.([^"\x27]+)./g)].map(m=>m[1]));
   const r="src/content/docs",f=[];
   (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:1})){const q=p.join(d,e.name);
   e.isDirectory()?w(q):/\.mdx?$/.test(e.name)&&f.push(p.relative(r,q).replace(/\.mdx?$/,"").replace(/(^|\/)index$/,""))}})(r);
   console.log("ORPHANS",f.filter(x=>x&&!s.has(x)));
   console.log("DANGLING",[...s].filter(x=>!f.includes(x)))'
   ```

   `{ label: 'HTTP API (Swagger)', link: '/api/' }` is a `link:`, not a `slug:`,
   so it is invisible to this check and is **not** dangling — `prebuild` supplies
   it. Any other `link:` you add needs checking by hand.

   **A renamed or moved page also needs a `redirects:` entry** in
   `astro.config.mjs` — Cloudflare Pages serves this site statically, so those
   emit meta-refresh stubs at the old paths and keep existing links and search
   results off a 404. Three are already there from #585. Nothing in the build
   warns you when one is missing.
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

When the diff carries **media**, add a fifth check: serve the built site and look
at it. `pm` is the way to give a reviewer a URL, and Astro's dev server is not —
it 403s the dev subdomain because `allowedHosts` is ignored. Build once and serve
`dist/` statically:

```bash
# /data/paddock-servers/<name>/serve.sh
cd "$SITE/dist" && exec python3 -m http.server "${PORT:-8080}" --bind 0.0.0.0
```

Then curl each new asset for a `200` **and** open the page in a browser: a video
that 404s still builds, and a still that has been silently dropped leaves no
trace in the build log.

**Positive-control every verification grep.** A grep that returns nothing is two
different results wearing one face: *the thing is absent*, or *your pattern is
broken*. On one pass a check reported that a page carried zero images; the page
was fine and the pattern was too narrow. So before believing a clean result,
run the same pattern against something you KNOW matches — the old value, a
literal test string — and confirm it fires. A pattern that matches neither the
old nor the new value is broken, not evidence. This costs one line and is the
difference between a verification and a reassuring noise.

**A control string must exercise the MATCHER, not merely the traversal.** This
is the sharper form of the rule above, and the one that survives being followed
carelessly. A scanner typically does two separable things: it walks a structure
collecting text, then it runs a pattern over what it collected. A control like
"assert some known-present word appears in the collected text" proves only the
*first* — that the walk ran and saw something. It passes unchanged when the
pattern itself is broken, so a scan with a malformed regex reports a confident
zero and reads as a clean bill of health. The control that discriminates is one
whose expected result depends on the pattern: seed a string you know the pattern
should match, and assert the scan *finds* it. If your control cannot fail when
the matcher is broken, it is measuring the wrong half.

**A viewport-restricted scan is valid only for the scroll positions actually
filmed.** A scan that asks "is this string inside the visible rect?" rather than
"is it in the DOM?" is the right call for a clip that never scrolls — an
off-screen path is genuinely not on camera, and reporting it is a false positive
that trains people to ignore the scanner. But its result is scoped to the frames
that were shot. Add a scroll to that film, or re-cut it from a different start
point, and previously-off-screen content enters the frame while the scan still
reports clean, because it was only ever asked about the old positions. Record
the scoping next to the check, so the next person to add motion knows the
guarantee narrowed rather than assuming it still holds.

**Cloudflare serves inconsistently mid-propagation.** After a merge, three
identical fetches of one page returned 1, 1, then 0 images. That is the CDN
mid-propagation, not a broken deploy, and sampling harder does not resolve it —
it just buys more contradictory samples. **Fetch the asset URL directly** (the
`/_astro/*.webp`, the `/demo/*.mp4`) rather than re-fetching the page and
re-counting what it references.

Note the grep hits you should expect and ignore. `127.0.0.1` appears **50 times
in total** — all legitimate loopback documentation — and the leak-check
instructions in this runbook match their own pattern:

| Where | Count |
|---|---|
| `website/src/content/docs/**` | **42** |
| `README.md` | **8** |

The 42 breaks down as 7 in `configuration/binding-and-exposure.md`; 6 each in
`getting-started.md`, `guides/connect-claude-code.md` and `guides/proxmox-lxc.md`;
4 each in `guides/dev-box-flavor.md` and `guides/running-as-a-service.md`; 2 each
in `guides/deploying.md` and `configuration/environment.md`; and singles in
`architecture/overview.md`, `guides/kubernetes.md`, `guides/securing.md`,
`reference/mcp.md` and `whats-new-archive.mdx`.

*(Recounted at the 0.70–0.72 What's New backfill: was 39/7 at v0.69, and
`guides/running-as-a-service.md` gained three. That pass added none of its own —
which is exactly why the drift is worth recording rather than re-deriving.)*

**Recount rather than trusting that number**, and recount the *split* as well as
the total. It drifts every pass — this is the second consecutive pass where it
did — and a stale baseline is how a real hit hides inside an expected one. The
previous revision of this paragraph is the cautionary example: it had the right
total but attributed all 46 to the docs subtree and then added "plus 6 in
`README.md`" on top, which sums to 52 and would have made a genuine new hit in
`README.md` look like an expected one.

**If your own PR edits any of the files you are counting, count at the END, not
at the start.** The figure before this one recorded a site count that was right
and a README count that was *already wrong when it was written*: the same commit
that wrote the baseline (#778) also closed two README gaps, and one of them added
the seventh `127.0.0.1`. The baseline was stale before it was pushed — not by
drift afterwards, but by the very PR that recorded it.

```bash
# the whole number, and the split, in one go
grep -ro '127\.0\.0\.1' website/src/content/docs --include='*.md' --include='*.mdx' | wc -l
grep -o  '127\.0\.0\.1' README.md | wc -l
```

---

## 8. Ship

- Branch per PR; never force-push.
- Docs-only ⇒ **no changeset, no version bump**.
- Let CI run. `.github/workflows/ci.yml` has exactly **three** jobs: `test`
  (NUL-byte check + typecheck + unit/integration), `website` (docs-site build)
  and `e2e`. Two things follow:
  - **No job here scans for secrets.** A **GitGuardian** check does run on the
    PR, but it is a GitHub App rather than a CI job, and it looks for
    *credentials* — it will not flag a private hostname, a dev-subdomain suffix,
    a LAN IP or your instance's branding, which is most of what a docs pass
    actually leaks. Treat the §7 leak check as yours alone.
  - The docs build is **path-filtered** to `website/**` and `openapi-site/**`, so
    a **README-only or `docs/`-only PR gets no docs build at all**. If your diff
    touches `astro.config.mjs` but nothing else triggers the filter, your local
    build is the only check that ran.
- Merge, then **verify live** — the site is Cloudflare Pages (root dir
  `website`, `npm install && npm run build`, domain `paddock.edspencer.net`).
  Curl the new and changed URLs for `200`, and check any published spec is
  stamped with the current version:

  ```bash
  node -p "require('./openapi-site/open-api.json').info.version"   # must match
  node -p "require('./package.json').version"                     # this
  ```

  Regenerate with `npm run build:server && node scripts/dump-openapi.mjs` if they
  have drifted.

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
- **The same rule covers claims about your own work, not only findings about the
  code.** "PR A is a strict superset of PR B", "I already re-shot that", "that
  branch has the corrections" are exactly as relayable-and-wrong as "feature X
  is not enforced" — and *more* dangerous, because a status claim is what gets
  used to stand a worker down or close an item, so being wrong cancels real work
  rather than merely adding some. Both a coordinator and a child produced one in
  the v0.69 pass: a "strict superset" asserted without reading the diff, and a
  "the corrections are missing" reported after grepping three branches that were
  not the right one. Before relaying a claim about state, name the command that
  established it — `gh pr view N --json files`, a diff, a grep whose pattern you
  positive-controlled — and if you cannot, say "I have not checked" instead.
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
