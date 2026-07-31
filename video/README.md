# Video production harness

Records the Paddock UI as real video, overlays captions, and assembles a cut.
**No GUI editing, no timeline app, no manual trimming.** The film is a program:
a manifest of segments, built by one command.

The point of that is not purity. It is that **a recut costs nothing**. Change a
caption, shave 300ms off a shot, reorder two beats — re-run one command and get
a new film, frame-exact, in a couple of minutes. That property is what makes it
reasonable to iterate on a video the way you iterate on code, and it is why this
lives in the repo instead of in someone's editor.

---

## The three stages

```
  scenes/*.mjs  ──►  $PADDOCK_VIDEO_OUT/s*.webm  ──►  manifest.mjs  ──►  final.mp4
  (record)           (source clips, NOT in git)      (the cut)          (+ final.gif)
```

Each stage is independent and re-runnable on its own. You record once, then cut
many times.

---

## Where everything is

```
video/
  lib/          the reusable engine — knows nothing about any particular film
    paths.mjs         every filesystem location, resolved in ONE place
    record.mjs        record(name, fn) — Playwright video context + cursor injection
    cinematics.mjs    moveCursor, humanClick, humanHover, humanType, smoothScroll, dwell, settle
    caption.mjs       caption text → transparent RGBA PNG; the STYLE object lives here
    assemble.mjs      manifest → trim → caption → concat → mp4 + gif
    fonts.mjs         private fontconfig, coverage checking
    build-fonts.mjs   one-time: packages/web/public/fonts/*.woff2 → static TTFs
    png.mjs           minimal PNG decoder + pixel diff (no ImageMagick on the box)
    postprocess.mjs   ffprobe wrappers

  videos/       one directory per film — content, not engine
    intro-90s/
      README.md       the shot list, what was staged, what is outstanding
      manifest.mjs    THE CUT: every segment, trim point and caption
      scenes/         scene1..scene5 + the *-prep.mjs seeders
      staging/        scripts that put the demo instance into a filmable state

  test/         make-test-clips.mjs, manifest.test.mjs, test-caption.mjs, verify.mjs
  tools/        send.mjs — WS client for driving a live turn out of camera
```

**The `lib/` ÷ `videos/` split is the load-bearing structure here.** Everything
in `lib/` is film-agnostic: it takes a name and a function, or a manifest, and
has no opinion about Paddock's UI. Everything under `videos/<name>/` is one
film's content — its shots, its trim points, its captions, its staging. A second
video is a new directory under `videos/`, not a fork of the engine. The original
harness was flat, which worked exactly as long as there was one film.

---

## Setup

This box exports `NODE_ENV=production`, which prunes devDependencies and breaks
things in surprising ways. **Prefix every invocation with `env -u NODE_ENV`.**

One-time, and only if `lib/fonts/` is missing:

```bash
env -u NODE_ENV node video/lib/build-fonts.mjs
```

That cuts static TTFs from **the repo's own webfonts** in
`packages/web/public/fonts/`, so captions are set in the same Inter the product
ships. The output is **not committed** — it is derived from files already in
this repo, and a binary font blob is not something git should be storing twice.
It needs a python venv with `fonttools` + `brotli`; see the header of
`build-fonts.mjs` for the two lines that create one.

### Where output goes

**Nothing under `video/` writes into the working tree at runtime.** Renders,
source clips, caption PNGs, scratch SVGs, the fontconfig cache and the per-scene
state files all live under one directory, resolved in `lib/paths.mjs`:

| variable | default | holds |
|---|---|---|
| `PADDOCK_VIDEO_OUT` | `/data/scratch/paddock-video/out` | clips, renders, gifs, `tmp/`, `captions/` |
| `PADDOCK_VIDEO_FONTS` | `video/lib/fonts` (gitignored) | the built TTFs |

A 90-second cut is ~250 MB of source `.webm` and three full renders during
verification. That is not repo content, and defaulting it outside the tree means
it cannot become repo content by accident. `.gitignore` blocks `out/`, `tmp/`,
`fonts/` and every `*.webm`/`*.mp4`/`*.gif`/`*.ttf` under `video/` as well —
belt and braces, for the case where someone points `PADDOCK_VIDEO_OUT` here.

---

## Why the architecture is the way it is

These are the decisions that are not obvious, with the reason each one is the
way it is. Most of them were arrived at by being wrong first.

### Real `recordVideo`, not stitched screenshots

The footage is genuine browser video via Playwright's `recordVideo`. Screenshot
stitching would be easier to control and would look it: you would lose streaming
text, spinner rotation, scroll momentum, and the cursor's travel between two
points — which is most of what makes a UI demo read as a *product* rather than a
slideshow. The cost of real capture is that you inherit Playwright's fixed
encoder settings (below) and cannot fix a bad take in post. That trade is worth
it, and one-clip-per-shot makes re-takes cheap enough that it doesn't bite.

### The cursor is a synthetic DOM element

Playwright's real mouse pointer is **not captured by the screencast**. Record a
click and you get a UI reacting to nothing — it looks like a ghost is operating
the app, and it is deeply disorienting to watch.

So `installCursor()` injects an overlay element via `addInitScript` (so it
survives navigation, which is exactly when you'd otherwise lose it) and
`moveCursor()` animates it in lockstep with the real `page.mouse` moves. The
drawn cursor and the real pointer are two things kept in sync, which is a bit
uncomfortable, but there is no API that makes the real one visible.

One consequence worth knowing: the synthetic cursor is a `position: fixed` div
on `<body>`. Anything that transforms the body — CSS `zoom`, for instance —
multiplies the cursor's own transform and it drifts away from what it is
pointing at. `scene5.mjs` zooms `#root` instead, for exactly this reason.

### One clip per shot

Each shot is a named function in a `scene*.mjs` and produces its own `.webm`.
Not one long take per scene.

This is what makes the whole thing re-takeable. A bad take on shot 3.5 costs you
shot 3.5, not the scene. Assembly then becomes *concatenation* rather than
frame-accurate trimming inside a long recording, which removes an entire class
of off-by-a-few-frames problem — the trim points are per-clip and independent,
so getting one wrong cannot desync the ones after it.

### Captions are SVG → PNG, never ffmpeg `drawtext`

`drawtext` was tried first and **silently dropped two caption lines** — one
containing an apostrophe, one containing a `·`. No error, no warning; the text
simply wasn't there. The cause is that `drawtext` takes its text *inside* the
filter-graph string, where the text shares an escaping namespace with the filter
syntax itself.

The fix is not better escaping. The fix is to make the bug impossible:

```
  text ──► SVG (XML-escaped) ──► librsvg ──► transparent RGBA PNG ──► ffmpeg overlay
```

**User text never enters an ffmpeg command line.** `overlay` takes a *file path*,
not a string, so there is nothing left to escape. One well-defined escaping rule
(XML) replaces an ad-hoc one. `'` `:` `,` `&` `%` `\` `<>` `·` `’` `—` are all
covered by assertions in `test/test-caption.mjs`.

This is the general shape of several decisions here: prefer the design where the
failure cannot occur over the one where it is merely handled.

**Do not reintroduce `drawtext` for captions.**

### The pill is sized by reading back pixels

`caption.mjs` renders in two passes. Pass 1 draws the text alone on a wide
transparent canvas and `png.mjs` reads the alpha bounding box — that gives the
exact ink extent and left side bearing with no font-metrics library and no
assumptions about shaping, kerning or script. Pass 2 sizes the pill to that ink
and centres the *ink*, not the advance box (which looks off-centre for glyphs
with asymmetric bearings).

The baseline is deliberately **not** derived from the caption's own ink. It comes
from a per-(font, size, weight) cap-height reference — the letter "H" — so every
caption in the film shares one baseline and one pill height whether or not its
text happens to contain a descender. That is the difference between a caption
*system* and twenty one-off captions.

### Exact frame arithmetic

Every segment is cut with `-frames:v round(duration × 25)` — a hard frame count,
not a timestamp ffmpeg is free to round. So **sum-of-segments == final duration,
exactly**, and `assemble.mjs` verifies it by probing the output (delta ≤ 1
frame, or it says `*** MISMATCH ***`).

That is what lets you converge on a 90-second target *arithmetically*: read the
per-segment table, decide you need 2.8s less, take it off three shots, re-run.
No trial and error, no drift accumulating down the timeline.

### One encode generation

Each source is decoded and encoded exactly once into a normalised intermediate
(same codec, size, fps, pix_fmt, SAR, with aligned GOPs), and hard cuts are then
joined with the concat **demuxer** and `-c copy` — zero recompression at the
join. Naively re-encoding the concatenation stacks artefacts, and at Playwright's
1 Mbit/s VP8 source bitrate there is no detail to spare.

`--crossfade` is the one exception: `xfade` must blend decoded frames, so the
whole timeline gets a second encode. It also **shortens the film** by
`(n−1) × crossfade` — 0.4s across 24 segments is 9.2s off a 90s target. Hard cut
is the default for both reasons.

---

## The measured capture constraints

These were characterised on this box; they are not assumptions. Playwright's
video capture is essentially non-configurable, so treat them as fixed inputs to
how you shoot.

| | |
|---|---|
| Frame rate | **exactly 25.000 fps, true CFR** — hard-coded in `playwright-core`, no API to change it. Zero drops over a 6s hold. |
| Resolution | 1920×1080; the viewport **must equal** `recordVideo.size` or Playwright pads with grey rather than scaling |
| Codec / bitrate | VP8 @ 1 Mbit/s, **not configurable** |
| `deviceScaleFactor` | 2 — supersamples glyphs (renders at 2×, downscales to 1×). Makes text *sharper*; does **not** raise resolution |

**The consequence is the important part: keep motion slow and areas of change
small.** At a fixed 1 Mbit/s, a fast scroll or a full-screen transition spends
the entire bitrate on one moment and mushes. Static and slow footage looks
genuinely crisp. Every shot in `intro-90s` holds ~2 seconds of stillness after
its last action, which also gives the caption a stable frame to sit on.

If a shot ever truly needs fast motion, the escape hatch is headful Chromium
under Xvfb with `ffmpeg -f x11grab`, which gives full control of bitrate. More
setup, materially better quality. Not needed so far.

> These numbers came from a set of throwaway probe scripts (`probe.mjs`,
> `qc-test.mjs`, `test-dsf.mjs`, `test-timing.mjs`, `test-interaction.mjs`) that
> were **not** kept — they were one-shot experiments whose only durable output is
> the table above and the design notes in `lib/record.mjs`. If you need to
> re-characterise something, write a new throwaway; don't try to resurrect them.

---

## Recutting — the common operations

```bash
cd video

# 1. Re-cut with different timings/captions — edit the manifest, then:
env -u NODE_ENV node lib/assemble.mjs videos/intro-90s/manifest.mjs --name final --target 90
#    Flags: --crossfade 0.4 | --no-gif | --gif-width 960 | --gif-fps 12 | --out DIR

# 2. Re-take ONE shot, then re-cut:
env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  node videos/intro-90s/scenes/scene3.mjs spawn
env -u NODE_ENV node lib/assemble.mjs videos/intro-90s/manifest.mjs --name final --target 90

# 3. Preview a single caption without rendering anything:
env -u NODE_ENV node lib/caption.mjs "Fork from any point" --out /tmp/c.png

# 4. Prove the caption path still handles awkward text (24 assertions):
env -u NODE_ENV node test/test-caption.mjs

# 5. Full objective verification of the pipeline (builds THREE renders):
env -u NODE_ENV node test/make-test-clips.mjs   # once, synthesises the fixtures
env -u NODE_ENV node test/verify.mjs
```

### Re-taking a single shot

Run the scene script with the shot name; with no argument it records every shot
in the scene. The clip lands at `$PADDOCK_VIDEO_OUT/<sN>-<shot>.webm`, replacing
the old one, and the manifest picks it up on the next assemble.

**Then re-derive that segment's `trimStart` — do not reuse the old one.** See the
gotchas below; this is the single most common way to waste an afternoon.

Two shots that are one continuous piece of reality (Scene 3's `ask` → `spawn`)
have a combined entry point — `node scene3.mjs live` — because re-taking the
second alone gets you a finished turn and no motion.

### Trimming to length

`assemble.mjs` prints a per-segment table and a `vs 90s target` line. Because the
total is exact, adjust `duration` on segments and re-run until it lands. There is
no need to guess.

---

## Adding a new video

The engine is film-agnostic, so a new video is a new directory. In order:

1. **Write the storyboard first, outside this harness.** The shot list, the
   captions and the durations are an editorial problem, not a technical one, and
   the manifest is a poor place to think. `intro-90s` was cut against
   `VIDEO-intro.md` in the paddock project notes.

2. **Create the directory:**
   ```
   video/videos/<name>/
     README.md      what this film is, its shot list, its staging, its gaps
     manifest.mjs   the cut
     scenes/        one scene*.mjs per scene
   ```

3. **Write the scenes.** Copy the shape of `videos/intro-90s/scenes/scene1.mjs`
   — it is the simplest one. A scene module is:
   - imports from `../../../lib/record.mjs` and `../../../lib/cinematics.mjs`
   - a `shots` object of named async functions taking `(page)`
   - a CLI tail that records one named shot, or all of them
   
   Each shot should `goto` → `settle(LEAD_IN)` → act → hold ~2s still. Record
   long; you trim in the manifest.

4. **Record.** `env -u NODE_ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node
   videos/<name>/scenes/scene1.mjs`. Clips land in `$PADDOCK_VIDEO_OUT`. Prefix
   filenames per film if two videos might share an output dir.

5. **Write the manifest.** Import `OUT_DIR` from `../../lib/paths.mjs` and build
   absolute clip paths from it — **never** a path relative to the manifest file,
   which is how renders would end up inside the repo. Copy the
   skip-missing-clips block from `intro-90s/manifest.mjs`: it lets you assemble
   and review a rough cut while most shots are still unshot, which is worth a
   great deal early on.

6. **Measure the trim points.** Play each clip, find the frame where the
   interesting thing starts, and put *that* in `trimStart`.

7. **Assemble, read the table, adjust durations, repeat.**

8. **Write the film's README** as you go, not at the end — specifically what you
   had to stage to make each shot possible. That is the part nobody remembers
   three weeks later.

---

## How the pipeline is verified

Not by eyeballing. `test/verify.mjs` builds the **same manifest twice, once with
every caption stripped**. Both renders are frame-locked, so a pixel diff at a
given timestamp isolates the caption and nothing else. It asserts:

- the caption region changes while the caption is up (meanAbsDiff 8.4–15.2)
- it is unchanged 0.16s *before* `captionDelay` and *after* `captionDuration`
- mid-fade is partial — a fade, not a pop
- accent pixels are physically present in the pill
- trim is frame-exact, proved with burned-in frame counters in the test clips
- container properties: h264, 1920×1080, yuv420p, exactly 25/1 CFR, faststart

One correction worth preserving: the first version asserted **bit-equality**
outside the caption pill, and failed on a photographic still. That was not a
leak — **two separate x264 encodes differ by ~0.03–0.15 everywhere** from
rate-control noise, against ~9 where a caption actually is. The checks are now
stated as signal-vs-measured-noise-floor, which is the correct formulation and
is why they're stable.

`test/test-caption.mjs` is the cheap one: 24 assertions on text handling, no
video, runs in seconds. Run it after touching anything in the caption path.

---

## Gotchas that will bite on a recut

1. **`trimStart` is MEASURED per clip, not nominal.** Static shots have ~2.2s of
   page-load lead-in and it is tempting to assume that everywhere. **Live-turn
   shots don't** — the interesting moment lands whenever the agent got there
   (`s3-spawn` at 15.5s, `s4-sendfile` at 38.8s). Re-record a live shot and its
   trim point moves, sometimes by tens of seconds. Re-derive it every time.

2. **Overrun freezes, it doesn't fail.** `trimStart + duration` past the end of a
   clip clones the last frame so the timeline stays in sync, and prints a warning
   naming the segment. A silent short segment would desync every caption after
   it, so this is the right behaviour — but it means **you must read the
   warnings**. A frozen shot looks like a bad recording, not like a bad manifest.

3. **The caption cache never evicts.** `$PADDOCK_VIDEO_OUT/captions/` is keyed on
   text + full style, so editing a caption leaves the old PNG behind. Harmless,
   but `rm -rf $PADDOCK_VIDEO_OUT/captions` to prune.

4. **Portrait clips need pre-compositing.** `recordVideo.size` must equal the
   viewport, so a mobile shot records at e.g. 430×932. Concatenating that into a
   16:9 timeline pads with grey. `s2-phone-16x9.webm` was made by compositing the
   portrait clip over a darkened, blurred, scaled copy of itself.

5. **Inter's latin subset is 230 codepoints.** Anything outside it — CJK, emoji,
   most symbols — falls back to DejaVu and looks visibly wrong next to the UI. It
   warns loudly, which is easy to scroll past.

6. **Disk.** `/data` sits near 85%, and `verify.mjs` builds *three* full renders.

7. **`smoothScroll` needs a target selector** for Paddock's main pane, which is a
   nested scroll container. A bare pixel delta scrolls `window` and does nothing.

8. **`env -u NODE_ENV` on every invocation.** This box exports
   `NODE_ENV=production`.

---

## The demo instance

Shot against `https://5015.dev.projects.valfenda.net/` — pm name `paddock-video`,
a **disposable instance** holding a reviewed copy of real-looking data, with
triggers stripped and `repo:` keys removed so nothing it does can fire on a
schedule or reach a real repository. See `VIDEO-intro.md` in the paddock project
notes for how it was built and what was staged.

> **Never point this harness at an instance you care about.** It is destructive
> by design: it sends real turns, creates and forks chats, edits read-state
> watermarks and commits to the working tree. Several shots only exist because
> the scene scripts mutated server state to set them up.
>
> It also records whatever is on screen into a file you may publish. Shoot only
> against a copy whose contents you have actually reviewed — every chat name,
> transcript and file that scrolls past ends up in the footage.
