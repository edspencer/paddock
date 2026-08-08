# intro-90s — the 90-second Paddock intro

**Target 90s, hard ceiling 2:00.** Thesis: *Paddock does for Claude Code what
tabbed browsing did for the web.*

The editorial source of truth is **`VIDEO-intro.md` in the paddock project
notes** — voiceover script, storyboard, tone rules, and the parking lot of
material that didn't survive the cut. This file covers only what you need to
*rebuild* the film.

Production model is two tracks: the voiceover is recorded in one continuous pass
and the video is cut against it. The video track carries roughly **four times**
as many ideas as the audio — ~7 spoken sentences against 28 shots and ~20
captions — so they synchronise at scene boundaries, not line by line. The
manifest deliberately does not model the VO.

```bash
# from video/
env -u NODE_ENV node lib/assemble.mjs videos/intro-90s/manifest.mjs --name final --target 90
```

Current state: **24 of 25 shots recorded, 92.84s / 2321 frames** — 2.84s over
target, before the cold open is added.

---

## Shot list

Trim points are **measured**, not nominal. Scene 1's shots have the usual ~2.2s
page-load lead-in; the live-turn shots do not, and their numbers look strange for
a reason (see the notes).

### Scene 1 — the problem, and the reveal · VO [1][2]

| clip | trim | dur | caption |
|---|---|---|---|
| `s0-terminal.webm` | — | 3.0 | — |
| `s1-reveal.webm` | 2.20 | 4.0 | Every conversation, named |
| `s1-projects.webm` | 2.20 | 3.0 | Sorted into projects |
| `s1-badges.webm` | 2.20 | 2.0 | Live: what's new, what's working |

`s0-terminal` is **not shot** — it is Ed's own zellij, on his own machine, and is
deliberately not faked with a generic terminal. The manifest skips it with a
warning until it exists.

The whole argument of the video is made in the first cut, from cluttered
terminal to clean sidebar. Everything after it is evidence. `s1-reveal` holds
still with no cursor movement on purpose: the cut itself is the statement.

`s1-projects` replaced a "grouped into areas" shot. No `area` is set on any
project on the instance, so the grid renders everything under one `Unsorted`
header and there was no grouping to show — and the real chat counts (252 / 35 /
15) are the more persuasive frame anyway.

### Scene 2 — off the laptop · VO [3]

| clip | trim | dur | caption |
|---|---|---|---|
| `s2-reload.webm` | 22.60 | 4.4 | Reload. Nothing lost. |
| `scene2-minipc.webm` | 0.00 | 3.0 | 8 watts. On 24/7. |
| `s2-phone-16x9.webm` | 4.60 | 5.6 | Same session, on your phone |
| `s2-readstate.webm` | 11.00 | 4.2 | Read state follows you |
| `s2-triggers.webm` | 16.40 | 4.8 | It runs while you're asleep |

`s2-reload` is a **live turn**: the reload itself is the beat, and it lands
~23.6s in, after the ask has been typed and the turn has run long enough to have
something on screen to lose. That is why the trim is 22.6 and not 2.2.

`s2-phone-16x9` was recorded **portrait** at 430×932 — `recordVideo.size` must
equal the viewport — then pre-composited into 16:9 over a darkened, blurred,
scaled copy of itself. Concatenating the raw portrait clip pads with grey.

`s2-triggers` carries **two beats in one clip**: the Triggers table, the tab
click at ~18.5s, then History's "13 new runs ran while you were away." Cutting it
shorter than ~4.5s loses one of them.

### Scene 3 — the multiplier · VO [4][5]

The longest scene and the best footage.

| clip | trim | dur | caption |
|---|---|---|---|
| `s3-ask.webm` | 18.50 | 3.0 | — |
| `s3-spawn.webm` | 15.50 | 5.0 | One chat starting three more |
| `s3-tree.webm` | 13.50 | 3.0 | Spawned chats nest under their parent |
| `s3-follow.webm` | 16.50 | 4.0 | Real chats — watch, stop, redirect |
| `s3-config.webm` | 6.40 | 3.4 | You choose what it can do |
| `s3-fork.webm` | 8.00 | 5.0 | Fork from any point |
| `s3-forkmodal.webm` | 10.00 | 2.0 | — |
| `s3-context.webm` | 7.00 | 3.0 | Context window, always visible |

Every trim here is derived from the actual recording, because these are live
turns. `s3-spawn` especially: the browser boots faster than the keeper's first
tool call, so the payoff is the **last ~10 seconds** of a 25s clip.

`ask` and `spawn` are one continuous piece of reality split across two clips —
`ask` types and sends, the turn then runs server-side independent of the browser,
and `spawn` relaunches onto the same chat seconds later to catch the `create_chat`
cards landing. **Run them together (`node scenes/scene3.mjs live`)**; re-taking
`spawn` alone gets you a finished turn and no motion.

`s3-forkmodal` is uncaptioned bonus texture. It exists because "Fork from here"
on the message hover rail forks **eagerly and navigates** — one click, no dialog
— while the *sidebar row's* fork action is the one wired to `ForkChatModal`.
These are two different features and the storyboard originally conflated them.
Don't script a modal appearing after "Fork from here"; it doesn't.

The `s3-config` caption was reworded from *"Off by default. You opt in."* On this
instance the self-MCP read **and** write toggles are visibly ON — Scene 3 needs
them or there is no spawn footage — so that caption would have been contradicted
by the frame it sits on. What the cursor actually lands on is
`Self-management MCP (projects)` unchecked and `Max spawn depth: 1`, which
supports the weaker, true claim.

### Scene 4 — chats become projects · VO [6]

| clip | trim | dur | caption |
|---|---|---|---|
| `s4-promote.webm` | 5.80 | 4.4 | Promote a chat into a project |
| `s4-newproject.webm` | 12.00 | 4.0 | Optionally backed by a git repo |
| `s4-changes.webm` | 11.50 | 4.5 | The agent commits its own work |
| `s4-sweeper.webm` | 8.60 | 4.0 | And keeps its own notes current |
| `s4-sendfile.webm` | 38.80 | 4.6 | Files come back rendered, not attached |
| `s4-crossproject.webm` | 30.60 | 3.4 | Chats reach across projects |

`s4-newproject` catches the git URL being typed between ~12.5s and ~15.5s, plus
the explainer under the field. It is **never submitted** — no clone happens.

`s4-sendfile` and `s4-crossproject` are live turns. The rendered file block lands
at ~39s; the `create_chat` card at ~29s, expanding at ~31s. Everything before
those points is typing and waiting.

### Scene 5 — close · VO [7]

| clip | trim | dur | caption |
|---|---|---|---|
| `s5-montage.webm` | 9.00 | 4.5 | Works with your Claude subscription |
| `s5-close.webm` | 6.00 | 4.0 | Self-hosted. Docker, Compose, Kubernetes. |

The montage is shot at CSS `zoom: 1.4` on `#root`. Mermaid sizes its SVG to the
container, so at 1× a ten-node pipeline renders with ~7px labels — present on
screen but unreadable after a 1 Mbit/s encode. Zoom is a layout property, so the
diagram genuinely re-lays-out bigger instead of being scaled up and softened.

It goes on `#root`, **never** `<body>`: the synthetic cursor is a
`position: fixed` div on the body, and zooming the body multiplies its transform
so the drawn cursor drifts off what it is pointing at.

---

## What had to be staged

All of this is on the **demo instance** (`paddock-video`, port 5015) — a
disposable copy with `repo:` keys removed and the armed `night-watch` trigger
stripped, so no keeper can reach a real repository and nothing fires on a
schedule. Never on an instance you care about.

**Seeded out of camera** — `scenes/scene3-prep.mjs` and `scenes/scene4-prep.mjs`
create the chats the live shots are filmed in, over the same WebSocket the UI
uses. A chat that already looks like work in progress reads far better than an
empty one, and recording the setup turn would waste footage. They write
`$PADDOCK_VIDEO_OUT/tmp/scene{3,4}.json` so the scene scripts — and any re-take
of a single shot — can find the chats again.

**Model pinned to Haiku** via a `localStorage` init script before the app boots.
The composer's select is backed by `paddock:chatModel:<sessionId>` and defaults
to Opus, which would put a model on screen that isn't the model running the turn.

**The ask names no model.** An earlier take said "…on Haiku" and the keeper
faithfully passed `model: "haiku"` to `create_chat` — not a valid id — which put
three red error cards in the middle of the payoff shot. The child chats' model is
set where it belongs, in `hushpod/project.yaml`, which `create_chat` falls back
to.

**Self-MCP write tools enabled** in the instance config. Without them the keeper
has no `create_chat` and Scene 3's payoff shot cannot exist. **Turn this off when
filming is done.**

**`staging/patch-readstate.py`** — rolls three root chats' `lastSeen` watermarks
back so they derive as unread, then restart the server (`ReadStateStore` is
write-through and loads the file once). Not the obvious route: `POST
/chats/:id/unread` sets the *manual* override, and on camera that only
half-works. The sidebar badge is `unread || at > readLastSeen(sid)`, and opening
a chat only bumps the client's in-memory `lastSeen` — so the row's dot clears but
the manual flag is still true in the cached payload, and the projects context has
no poll, so the aggregate Home count sits there stale for the rest of the take. A
watermark-derived unread clears both in the same frame, which is the entire point
of the shot.

**`staging/reset-runs-seen.py`** — rolls a workspace's run-history watermark back
so the History tab shows its "N new runs ran while you were away" banner again.
Opening the tab POSTs `/runs/seen`, which retires the banner, so it is a
**one-shot on-camera moment and every probe run burns it**. Restart the server
after running it.

**Scene 2's shots use the root workspace's own chats** (the seeded "NAS backup /
drip irrigation / …" ones) rather than the copied production transcripts. Those
six were authored for the demo, so they are the only transcripts on the instance
certain to be free of anything that shouldn't be on camera.

---

## Outstanding

1. **`s0-terminal` — the cold open.** Ed's own zellij, on his machine. 3s. Must
   be captured off this box; the manifest skips it with a warning until it lands.
   Without it the film starts on the reveal, which loses the contrast the whole
   opening argument depends on.

2. **The mini-PC photograph.** `scene2-minipc.webm` is currently a placeholder
   slate. Ed has photographs; no shoot needed. This is the only claim in the
   video a screen recording cannot make, and it's the most persuasive thing in it
   for the self-hosting audience — worth the full 3 seconds and a slow push-in
   rather than cutting through it.

3. **2.84s over target** at 24 shots, before the 3s cold open. So the finished
   film is ~5.8s long and needs trimming. The per-segment table makes this
   arithmetic: pick the shots that can lose 300–500ms and take it off them.

4. **Turn the self-MCP write toggles back off** on the demo instance when
   filming is finished.

5. **Staging gaps that are faithful to production, and that's the problem** —
   the root workspace's empty summaries and untitled areas are real, not copy
   errors. Fixing them means inventing descriptions of Ed's own projects, so they
   need his wording. See the "Staging gaps" section of `VIDEO-intro.md`.
