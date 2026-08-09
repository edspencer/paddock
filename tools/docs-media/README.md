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
