# docs-media — screenshots for the docs site

Re-runnable capture for the images under `website/src/assets/`. Every shot in
`capture.mjs` names the docs page it serves, so a stale image can be traced back
to the prose that depends on it.

**This is a script and not a list of clicks on purpose.** A visual-design
overhaul makes every screenshot stale at once, and re-shooting has to be
`node capture.mjs`, not a human re-deriving a dozen navigation paths from memory.

## What it needs

- A **Paddock instance holding demo data** — fictional project names, fictional
  chat titles, no real transcripts. Point at it with `--base` or
  `$PADDOCK_RIG_BASE`. Never shoot production.
- `playwright` and `ws` resolvable from this directory (`npm ci` at the repo
  root, or an `npm i playwright ws` in a scratch dir you run from), and a
  Chromium install — `npx playwright install chromium`, or set
  `PLAYWRIGHT_BROWSERS_PATH` at an existing one.

The rig's own launcher is deliberately **not** committed: it is specific to one
machine's paths, ports and process manager. What matters is the contract above.

## Running

```bash
export PADDOCK_RIG_BASE=http://127.0.0.1:4000

node stage-attachments.mjs --slug <project>   # only needed for the attachments shot
node capture.mjs --out ../../website/src/assets/staging
node capture.mjs --only adopt-modal           # one shot while iterating
```

`stage-attachments.mjs` drives the two real steps a browser takes — a multipart
upload, then `chat:send` carrying the returned ids. It exists because an
attachment lives in the attachment store, not in the transcript JSONL, so
hand-writing a `.jsonl` cannot produce one; it would only fabricate a shape and
risk photographing something the UI renders by accident.

## The leak check, and its two traps

`capture.mjs` scans the page's **text nodes** before every shot and refuses to
write the file if anything matches. It also hides the deepest matching element
first, so a leaking `<span>` is masked without taking its parent pane with it.

- **`strings shot.png` is not a leak check.** Rendered text is pixel data — a
  screenshot showing a live token greps clean. Scan the DOM, then *look at the
  committed image*. Both, every time.
- **Put anything that names your machine in `$PADDOCK_LEAK_EXTRA`**, as regex
  alternatives:

  ```bash
  export PADDOCK_LEAK_EXTRA='corp\.example|buildbox-\d+'
  ```

  It is not hard-coded in `capture.mjs` because this file is public: writing a
  private domain here in order to *detect* it would publish the very string it
  guards. That is not hypothetical — an earlier draft of this tool carried a
  private dev domain in its own detection regex.

## Framing

Shots take an optional `selector`, and `fitToLast` to clip at the bottom of the
last matching child. Use them. A scrollable list is as tall as its viewport
rather than its content, so an unframed element shot of a four-row chat list is
~40% empty; and a 16×16 provenance badge photographed inside an 1180px window is
unreadable at the width of the docs column. An unframed shot also silently
duplicates: two shots of the same URL at the same viewport differ only in what
you *meant* to point at, and will land as byte-identical files.

## Provenance sidecars

Every shot writes `docs-<name>.png.json` beside it, and `shots.manifest.json` is
the committed aggregate. It records theme, light/dark, hue, tint, the solved
`--accent`, the app version, route and viewport.

This exists because with four runtime themes and a free accent picker, **"which
theme is this?" is not answerable from a PNG** — and that question is most of
what makes deciding a re-shoot expensive. Everything in the sidecar is *observed
from the live page* rather than restated from the requested config, so a theme
that silently failed to apply is detectable afterwards instead of only at
capture time. The four quartet shots recording four different accent triples is
what proves the themes really applied, rather than four labels being written
over one appearance.

**It also answers "is this frame stale?" without opening the PNG.** Because each
sidecar records the **app version**, a change that repaints part of the UI turns
a squinting exercise into a file read: list the shots whose `appVersion`
predates the change and whose `route` could show the affected surface. That
stopped being hypothetical within hours of the sidecars existing — a PR landed
repainting inline `code` and blockquotes in chat prose, and "which of these
frames shows rendered transcript prose?" was answerable per frame from `route`
alone, rather than by inspecting a dozen images.

## The rig

`serve.sh` stands the instance up and `seed.mjs` fills it. Both are driven by
environment, so neither carries a machine's paths:

```bash
export PADDOCK_RIG_HOME=/srv/scratch/docs-media      # home/, data/, projects/
export PADDOCK_RIG_CLONE=/srv/checkouts/paddock      # a BUILT checkout
export PADDOCK_RIG_PROJECTS=/home/demo/projects      # optional; on camera
export PADDOCK_RIG_FIXTURES=$PWD/fixtures.json       # optional; authored replies
PORT=4000 ./serve.sh
```

The contract a rig must satisfy — all of it, not most of it:

1. `driveMode: batch` with a fake `claude` on `PATH`. The **default is
   `session`**, which uses the SDK runtime, ignores `PATH` entirely, and calls
   the real API. It does not look like a failure: turns complete fast with
   plausible replies, and you are billed.
2. An isolated `PADDOCK_DATA_DIR` **and** `HOME` **and** `CLAUDE_CONFIG_DIR`.
   `PADDOCK_DATA_DIR` isolates the data dir only; anything resolving the Claude
   home via `os.homedir()` lands on the operator's real `~/.claude`.
3. `AUTH_MODE=none` — so bind loopback. Capture runs on the same host.
4. A projects root holding only synthetic projects, **on persistent storage**.
   The previous rig kept its projects on a path that was not a mounted volume; a
   container restart destroyed every `project.yaml` and every transcript while
   the data dir survived. Wipe the projects tree and the data dir **together or
   not at all** — half a wipe leaves job records describing chats whose
   transcripts are gone, and that renders as a subtly broken instance in the
   screenshots.

**Liveness is not identity.** `pm status: online` and `/api/health: 200` are
both satisfied by a stale squatter on your port, and a seeding run has already
written into the wrong instance that way. `seed.mjs`'s `assertIsRig()` checks
the instance's `dataDir` and `driveMode` from `/api/instance-config` and refuses
to proceed otherwise. Do not bypass it.
