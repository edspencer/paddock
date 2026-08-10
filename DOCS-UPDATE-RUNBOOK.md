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

### When the release changes the design itself

A release that restyles the whole app — new tokens, new themes, a reworked
screen — invalidates screenshots on pages that never mentioned it. This was the
hardest judgement of the v0.69 pass and there was no guidance for it, so:

**The rule is not "re-shoot everything".** Two claims are in tension, and both
are right:

- **A What's New entry describes the release as it shipped.** A historical entry
  showing the *old* UI is **correct**. Re-shooting it rewrites history — it makes
  the 0.62 entry claim 0.62 looked like 0.69, which it did not. §6 already says
  do not rewrite superseded entries; a screenshot is part of the entry.
- **A page describing current behaviour showing an obsolete UI is simply
  wrong.** "Here is the Config screen" beside a picture of a Config screen that
  no longer exists is a false statement, however carefully the prose is worded.

**Bucket by the tense of the surrounding prose, not by the directory.** The
directory is a tempting proxy — `assets/whats-new/` is history, everything else
is current — and it is only *usually* right. It fails on exactly the assets that
matter: a still cited from both a current page and an archived What's New entry.
Directory says one thing; the two citations disagree. Read what the prose around
each citation claims, in each place it is cited.

**For those dual-use assets, fork rather than choose.** Shoot a new frame for the
current page under a new filename, and leave a byte-identical copy of the old one
in `whats-new/` for the archive entry. The duplication is the point: one file
cannot simultaneously be a correct historical record and a correct picture of
today, and trying to make it both silently corrupts whichever claim you did not
have in mind when you re-shot it.

Practically, before shooting anything, list every asset the release plausibly
invalidates and grep for **each** of its citations:

```bash
grep -rn "assets/whats-new/appearance-panel.png" website/src
```

An asset with one citation is easy. An asset with two is the one that needs the
fork, and it is invisible if you only looked at where the file lives.

### Video: use the harness, and ship MP4 not GIF

**A video-production harness exists, but it is NOT on `main`.** `git ls-files video`
is empty at v0.66.2, and `491c4c6` ("chore(video): move the video-production
harness into the repo", #584) is not an ancestor of `HEAD`. **Locate it before
planning around it** — do not assume a `video/` directory in a fresh clone.

If you do find it, do not write your own recorder: it gives you Playwright
`recordVideo` capture, a *synthetic* cursor (Playwright's real pointer is not
captured by the screencast, so without it the UI looks like a ghost is driving),
eased human-ish motion, and a caption/assemble pipeline for full films. Read
`video/README.md` first; the measured capture constraints there are inputs, not
suggestions.

What *is* on `main` is the `DemoVideo` Astro component
(`website/src/components/DemoVideo.astro`), and the measurements below still hold.

A new film is a new directory — `video/videos/<name>/scenes/*.mjs` — never a fork
of `lib/`. For a single docs clip you only need `record()` plus `humanClick` /
`dwell` / `settle` from `lib/cinematics.mjs`; the manifest and caption machinery
are for cut films. Run everything with `env -u NODE_ENV
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` and point `PADDOCK_VIDEO_OUT` outside
the repo.

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

#### The rig is disposable — make sure it is also reproducible

Treat the rig as something that **will** disappear without warning, because it
has. Not every path on a dev box is on a persisted volume, and a rig assembled
by hand in an interactive session tends to end up spread across both kinds.
Check which is which before you put anything you care about somewhere:

```bash
findmnt -no TARGET,SOURCE | sort     # what is actually a volume here
```

On this box `/data` is persisted and `/home` never was. A rig whose
`PADDOCK_PROJECTS_DIR` pointed under `/home` therefore lost its **entire
projects tree** on a container restart — while its `PADDOCK_DATA_DIR`, which sat
elsewhere, survived intact.

**That asymmetry is the dangerous part.** Losing both would be obvious: the rig
would fail to boot and you would rebuild it. Losing one leaves an instance that
boots perfectly happily to **zero projects plus a set of orphaned job records** —
which presents as "huh, empty instance, I must not have seeded it yet" rather
than "this instance has been destroyed". The natural next move is to re-seed on
top of the wreckage, and the orphaned records then make chat counts and unread
badges disagree with what is actually on disk for the rest of the session. Split
data and projects dirs across a persistence boundary and you have built a rig
that fails misleadingly instead of loudly.

The mitigation is not "remember which directory to use" — it is that **the rig
must be reproducible from the repo**, so that losing it costs a command rather
than a session. **PR #828 has just made it so**, moving an env-driven `serve.sh`
and `seed.mjs` (plus the capture driver and its shot manifest) into
`tools/docs-media/`. Start from those rather than writing a launcher by hand, and
keep any fix you make to them *in the repo* — a rig improvement that lives only in
a scratch directory is one restart from never having happened.

Note that `tools/**` is outside the docs CI path filter (§8), so changes there get
no docs build. Your local run is the only check.

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

#### And prove the bundle you are photographing is the one you released

Right instance, wrong build is a separate failure, and it is the quieter of the
two. A rig serving `dist/` from a clone that predates the release will
faithfully paint the **old UI**, and every downstream check still passes: the rig
comes up, seeding succeeds, the leak scan is clean, every shot is captured at the
framing you asked for. Nothing anywhere reports an error. The only tell is the
design itself — which is precisely what nobody examines while concentrating on
framing, cropping and leaks. You ship a set of "re-shot" screenshots of the
release you were replacing.

`git log`-ing the clone is a weak check: it tells you what the *source* says, not
what the process is serving. A build can predate the checkout, `dist/` can be
stale, and `pm` will happily keep serving an artefact whose source has moved on.

**Assert positively against the served bundle instead.** Name one UI element that
**only the new build can paint**, then go and look for it before you shoot
anything else. It is a single navigation and it converts a silent failure into an
immediate one.

For v0.69 that check was: open `/config` and confirm the **Appearance** section
with its four theme cards exists. Before #780 there is no such section to find,
so its presence is proof and its absence is proof — there is no ambiguous middle.

Generalise, don't copy: pick the check per release. A good one is a whole
**section, screen or control that the release introduced** — cheap to reach and
binary. A bad one is a restyled colour or a moved margin, which you cannot judge
by eye against a build you have not seen. If the release introduced no such
element, say so and fall back to comparing a rendered frame against the previous
pass's committed still.

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

### The `127.0.0.1` baseline

Note the grep hits you should expect and ignore. As of **v0.69.0**, `127.0.0.1`
appears **46 times** across `website/src/content/docs/**` + `README.md` — all
legitimate loopback documentation (bind examples, `--host 127.0.0.1`
invocations, reverse-proxy upstream targets, `PADDOCK_HOST` defaults):

| File | Hits |
|---|---|
| `README.md` | 7 |
| `configuration/binding-and-exposure.md` | 7 |
| `getting-started.md` | 6 |
| `guides/connect-claude-code.md` | 6 |
| `guides/proxmox-lxc.md` | 6 |
| `guides/dev-box-flavor.md` | 4 |
| `configuration/environment.md` | 2 |
| `guides/deploying.md` | 2 |
| `architecture/overview.md` | 1 |
| `guides/kubernetes.md` | 1 |
| `guides/running-as-a-service.md` | 1 |
| `guides/securing.md` | 1 |
| `reference/mcp.md` | 1 |
| `whats-new-archive.mdx` | 1 |
| **TOTAL** | **46** (39 site + 7 README) |

This runbook itself carries three more, because the leak-check instructions
match their own pattern. Occurrences and matching lines are equal today (46 =
46, i.e. no line carries two hits), so `grep -c` and `grep -o | wc -l` happen to
agree — they are different questions, so say which one you ran.

**Recount rather than trusting that number.** That warning has now been earned
twice over, and *how* it drifted is more useful than the number:

- The previous figure — "38 across the site plus 6 in `README.md`" — recorded a
  **site count that was correct** and a **README count that was already wrong
  when it was written**. The commit that wrote the figure (#778) also closed two
  README gaps, and one of them added the seventh `127.0.0.1`. The baseline was
  stale before it was pushed. **If your own PR edits any of the files you are
  counting, count at the end, not at the start.**
- Since then the site gained exactly **one** hit: `guides/running-as-a-service.md`,
  a new page from #804. Note what did *not* move it — #803 rewrote
  `getting-started.md` around Discover, one of the most loopback-dense pages on
  the site, and left it at 6. "A big docs PR landed" is not a proxy for "the
  baseline moved", in either direction. Only a recount is.

A stale baseline is how a real hit hides inside an expected one, so the recount
is cheap insurance against the one failure this check exists to catch.

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
