# `scripts/demo-gif/` — the README / docs demo GIF

Regenerates `docs/demo/paddock-demo.gif` (and the byte-identical copy at
`website/public/demo/paddock-demo.gif`), plus MP4/WebM versions of the same
timeline. Eleven beats, about 22 seconds.

Everything it shows is **synthetic** — invented projects, invented chats, an
invented git repo. No production data, no real repositories, no credentials.
That is a hard constraint: the output ships in the README and on the marketing
site. Keep it that way if you extend the fixtures.

## Re-running it

```bash
npm run demo:gif
```

That is the whole thing: seed → boot → drive → capture → encode → copy both
committed copies into place. About four minutes.

It **preflights** first and refuses to start if anything is missing, naming the
command that fixes it — so you find out in a second rather than four minutes in.
The three prerequisites, if you'd rather set them up ahead of time:

```bash
NODE_ENV=development npm install --include=dev   # the box exports NODE_ENV=production
env -u NODE_ENV npm run build                    # the shoot runs the built server + SPA
npx playwright install chromium
```

(You don't need `env -u NODE_ENV` on `demo:gif` itself — it scrubs the variable
for everything it spawns.)

It is safe to re-run: it re-seeds a throwaway data dir under `/tmp/paddock-demo`
every time and never touches your real Paddock state.

To iterate on the encode without re-shooting (seconds, not minutes):

```bash
node scripts/demo-gif/make.mjs --skip-shoot        # re-encode + reinstall
node scripts/demo-gif/build.mjs --out /tmp/paddock-demo --colors 128   # just try a setting
```

Stills land in `/tmp/paddock-demo/stills/`, output in `/tmp/paddock-demo/dist/`.

## The pieces

| File | Does |
| --- | --- |
| `fixtures.mjs` | The synthetic world: projects, summaries, the file contents behind the git diff, the trigger definitions. **Edit this to change what the demo is about.** |
| `beats.mjs` | The storyboard — which beats, in what order, held for how long. Read by both the shoot and the build, so they cannot drift apart. |
| `seed.mjs` | Writes a complete `PADDOCK_DATA_DIR`: chats with rich tool blocks, a finished sub-agent, job records, read state, triggers, and a real git repo. |
| `shoot.mjs` | Boots a server on the seeded dir, drives live turns, and captures one PNG per beat with Playwright — plus one recorded screen capture. |
| `build.mjs` | Crossfades the stills with ffmpeg and encodes GIF + MP4 + WebM. |
| `serve.mjs` | Launches the demo server with a scrubbed environment. Also runnable standalone to eyeball the rig. |
| `lib/transcript.mjs` | Builders for Claude Code transcript JSONL lines, annotated with the rules that make each tool block render. |
| `lib/png.mjs` | A tiny dependency-free PNG writer, used to draw the palette image the demo's `Read` block renders inline. |

## Changing the demo

**To change the storyboard** — edit `BEATS` in `beats.mjs`, then add or adjust
the matching capture block in `shoot.mjs`. A beat is a beat id, a hold duration,
and the code that navigates to it. `shoot.mjs` fails loudly if a beat in the list
has no still at the end of a run, so the two stay in sync.

**To change the content** — edit `fixtures.mjs`. The star chat's tool calls live
in `starChat()` in `seed.mjs`.

**To eyeball the rig without shooting**:

```bash
node scripts/demo-gif/seed.mjs --out /tmp/paddock-demo
node scripts/demo-gif/serve.mjs --data /tmp/paddock-demo/data \
  --home /tmp/paddock-demo/home --port 7311
# then open http://127.0.0.1:7311/
```

## Things that will bite you

These are all load-bearing, and each one fails *silently* — which is why they are
written down rather than left to be rediscovered.

- **A chat with no job record is invisible.** herdctl gates every discovered
  session on an attribution record naming the owning agent; an unattributed
  session resolves to `agentName: undefined` and simply never appears. `seed.mjs`
  writes a `.herdctl/jobs/job-*.yaml` per chat. The `id` field is zod-validated
  against `job-YYYY-MM-DD-[a-z0-9]{6}` — **lowercase** — and a bad id is dropped
  as a corrupt record.

- **Seed before boot.** The attribution index and the session listing are both
  cached for 30s. Writing chats into a running instance means either a long wait
  or, more likely, quietly shooting a stale UI.

- **`tool_result.content` must be a non-empty string.** An empty result is
  dropped entirely, which leaves the tool card spinning "pending" forever *and*
  desynchronises the detail cursor — tool details are joined to cards positionally
  within each tool-name bucket, so one dropped result slides every later card of
  that tool onto the wrong data.

- **`toolUseResult` is a top-level key** on the tool_result line, a sibling of
  `message`. Snake_case `tool_use_result` is an older shape that gets matched
  first and returns early, silently bypassing everything.

- **The git repo lives at the projects root**, not inside a project. Paddock's
  backing store is one repo for all projects, and a project's Changes tab is that
  repo filtered to the project's subtree. `git init` inside `lumen-cli/` leaves
  every Changes tab reading `repo: false`.

- **An event trigger's field is `on`**, and its value must be one of the known
  events (`onArchive`, `afterTurn`). A schedule trigger needs exactly one of
  `cron`/`interval`, and every trigger needs exactly one of `prompt`/`promptFile`.
  Violations are dropped at load with no error.

- **The context meter's denominator comes from the project's `model`**, not from
  the model on the transcript.

- **The environment must be scrubbed, not overridden.** A devbox already running
  Paddock exports ~20 `PADDOCK_*` vars; `PADDOCK_BRAND_NAME`/`_LOGO` silently
  rebrand the sidebar in every frame, and `PADDOCK_DATA_DIR` would point the demo
  at production. `serve.mjs` builds the child env from a whitelist.

- **Never kill "stray" Paddock processes by pattern.** A devbox runs many
  instances, production included; `node .../server/dist/index.js` matches all of
  them. `serve.mjs` refuses to start when the port is occupied instead — and note
  that a stale server on the port will happily answer the health check, so
  without that guard a run can silently photograph the wrong instance. If you do
  need to find this pipeline's own server, match on its `PADDOCK_DATA_DIR` in
  `/proc/*/environ`.

- **`reducedMotion: "reduce"` is what makes the shoot deterministic.** The UI has
  spinners, pulsing dots, a blinking caret, and a "working" pill that cycles
  random phrases. The app's CSS honours the media query and freezes all of it.

- **The Running feed cannot be faked on disk.** It reads the server's in-memory
  session hub, so `shoot.mjs` drives two genuinely live turns using the fake
  `claude` binary's `[[HANG]]` directive (stream a reply, never write the
  terminal result). The directive must appear in the prompt, so it is sent as a
  follow-up into chats whose *name* — taken from their seeded first message — is
  what the feed row displays.

- **Mermaid renders client-side, and its `<svg>` id is its own.** Wait on
  `.mermaid-host svg`, not `svg[id^="mermaid"]` — mermaid stamps ids like
  `mmd-r24-svg`, so the obvious selector never matches and the wait times out
  even though the diagram drew fine. Allow a couple of seconds: the library is
  code-split across several chunks and draws after the page is otherwise idle.

- **Send a diagram as its own `kind: "mermaid"` file, not a ```mermaid fence
  inside a markdown send.** In a long markdown body the diagram renders as a
  blank bordered box (the resize wrapper remounts mid-render and the async draw
  is never retried — filed as #644).

- **Size a Mermaid diagram deliberately.** A tall top-down chart renders at its
  natural size and overflows the card; a long left-right one scales down to fit
  the width and takes its labels with it. Aim for roughly 2:1.

- **The message hover-rail only exists for turns with a real UUID id**, so the
  chat must be loaded from history — a message you just sent has an ephemeral
  id and no rail. And the rail floats on `-top-3`, overlapping the bubble above
  it, so a click gets intercepted: `focus()` the button instead (the rail is
  revealed by `group-focus-within` too) and press Enter.

- **A nested chat row suppresses its own "spawned" badge.** The sidebar guards
  on `depth > 0 && origin === "spawned"`, so a chat shows the indent or the chip,
  never both.

- **`trigger_type` in a job record does not make a run "unattended".** Only
  `origin` in `run-provenance.json` does (`scheduled`/`spawned`). A scheduled
  chat without a provenance entry renders as origin "You" and is filtered out of
  History's default view.

## The motion beat, and why the GIF differs from the video

One beat (`motion`) is a real Playwright screen recording rather than a still: a
message being typed, sent, the turn going busy, and the answer landing.

Two things about it are worth knowing.

**It is the only beat shot without `reducedMotion`**, so it gets the blinking
caret, the live spinner and the cycling "working…" pill. It runs in its own
browser context precisely so that turning motion on there cannot affect the
determinism of any other beat.

**The GIF does not use it.** Motion is nearly free in H.264/VP9 and ruinous in
GIF — every frame of a moving beat changes every pixel. This one 4-second clip
took the GIF from 1.6 MB to **6.5 MB**, and still cost 4.4 MB at 6fps, by which
point the crossfades stutter. So the video outputs play the clip and the GIF
holds a poster frame taken from the same moment. Same storyboard, same length;
the GIF simply doesn't move during that beat.

There is no token-by-token typing to film, incidentally. The deterministic fake
`claude` writes each reply as a single transcript line, so the streaming you'd
see against a real model isn't available here — and making the pipeline depend
on real API credentials would mean nobody else could re-run it.

## Format notes

The build emits three files:

| File | Size | For |
| --- | --- | --- |
| `paddock-demo.gif` | ~1.9 MB | The README, where GitHub will not play a committed video inline. |
| `paddock-demo.mp4` | ~1.5 MB | A web page, via `<video autoplay muted loop playsinline>`. |
| `paddock-demo.webm` | ~1.5 MB | Ditto, as the first `<source>`. |

**Prefer the video on the web.** It has the motion beat, no palette
quantisation, and it does not force the browser to hold a 177-frame
uncompressed animation in memory. The GIF exists because GitHub's README
renderer needs it.

See the header comment in `build.mjs` for the size levers, measured. The short
version: crossfade duration dominates, then frame rate; colour count barely
matters once dithering is off, and dithering should stay off for flat UI colour.
Downscaling the GIF is a weaker lever than it looks.
