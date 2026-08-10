# accent-picker — the 0.67 Appearance clip (~24s)

Ships as `website/public/demo/accent-picker.mp4` + `accent-picker-poster.jpg`,
through the `DemoVideo` Astro component.

> **This film needs `video/lib/`, which is on PR #584 (`video/demo-harness`) and
> is NOT on `main`.** Only `videos/accent-picker/` is added here; #584 was
> deliberately not merged. Until it lands, run this from a worktree of that
> branch with this directory copied in. When it lands, this works as-is.

## Why a video and not a still

A still of the accent picker is a screenshot of a slider. The subject is a
*continuous* change — one click and the wordmark, the nav row, the chip
borders, the preview row's button, link and status dot all move together. That
is the thing a reader cannot infer from a static frame, and it is the headline
of the release the 0.67 What's New entry has to carry.

## ⛔ What this clip must never claim

**Two opposite captions are both wrong here, and the true position is narrower
than either.** `solve()` does treat the contrast floor as a guarantee, and
`repairFill` does repair derived tokens — so "nothing is enforced" is false.
But when the solve *fails*, it is applied silently: `hit` is discarded and
`report.ok` is never surfaced (#813; #816 is the tint equivalent) — so "every
combination passes AA" is false too.

So no caption in this cut goes near readability in either direction. The claim
is *the whole UI follows*, which is exactly what the frames show and is
independent of the open issues.

If you re-cut this and are tempted to add a beat showing a colour being rejected
or clamped: that beat cannot be shot. A failing solve produces no visible
refusal — that silence is precisely what #813 is about.

## Shots

Four takes, one clip each (`scenes/scene1.mjs`), cut into six segments — two
clips are each split in two so a beat can carry its own caption.

| clip | what happens | measured |
|---|---|---|
| `accent-open` | land on `/config`, hold still | lead-in 2.4s |
| `accent-hues` | Teal → Ember → Violet | 4.6s · 8.5s · 11.4s |
| `accent-persist` | pick Violet, navigate to a project | 4.7s · 7.3s |
| `accent-themes` | Parchment → Terminal → Sci-Fi | 4.8s · 8.8s · 12.0s |

**Those trim points are measured off 2 fps contact sheets of the actual clips,
not assumed from the nominal lead-in.** Re-record a shot and re-derive its
trim point — the clicks land wherever the cursor animation got to.

Getting this wrong is quiet rather than loud: the first cut put Sci-Fi 1.0s
before the end, so the payoff beat read as the film running out rather than as
an arrival.

## Staging

Shot against a `docs-media`-style rig — synthetic projects only, `driveMode:
batch`, a fake `claude`, isolated `HOME` **and** `CLAUDE_CONFIG_DIR`. See
`tools/docs-media/` (PR #830) for the launcher and seed. Beyond the standard
seed, three of the four adoptable native sessions were adopted into Tidepool so
the destination of the route-change beat has real chats with real relative dates
rather than an empty state.

`PADDOCK_RIG_BASE` points the scene at the rig; there is no baked-in port.

## Appearance is pinned in `addInitScript`, not `page.evaluate`

Three localStorage keys, read by a **pre-paint** inline script. Setting them
after `goto` is too late — you get a flash, or a frame captured mid-swap.
`paddock:appearance-cache` is removed rather than left, because it is keyed
`<theme>:<dark|light>` and a stale entry paints the previous accent for one
frame.

The pin is **idempotent**, guarded by a sentinel key. An unconditional init
script re-runs on every navigation and would reset the accent during the
route-change shot — which would still look fine, and would be showing the
opposite of what the caption says.

## Leak check

The film never scrolls, and every frame sits at `scrollY: 0`. That matters:
`/config`, `/projects/<slug>` and Home all carry host paths **below the fold**
(the Advanced read-only section, the project working directory). A whole-document
`innerText` scan reports those and is correct to; what decides whether a clip is
publishable is whether a leaking element was ever *inside the viewport*. Both
scans were run — document-wide and viewport-restricted — with a control string
proving the matcher discriminates. Nothing was on camera.

**If you add a scrolling beat, re-run the viewport-restricted scan at every
scroll position, not just at the top.** And `strings clip.mp4` is not a leak
check: rendered text is pixels.

## Encoding

`segmentCrf: 32`, not the harness default of 16. The join is `-c copy`, so the
shipped bitrate is set by `segmentCrf` — `finalCrf` only bites under
`--crossfade`. At 16 this came out at 4.4 MB, faithfully preserving VP8's own
1 Mbit/s compression noise; 32 lands at ~1.3 MB with no visible difference on UI
chrome, checked by comparing crops at 26 / 30 / 34.

Durations are exact frame multiples (0.04s steps). A 2.1s segment asks for 52.5
frames and gets 53, and four such segments put the film two frames past its own
expected total — `assemble.mjs` reported `*** MISMATCH ***`, correctly. Quantise
rather than ignoring the warning; the exact-frame arithmetic is only worth
having if the check stays meaningful.
