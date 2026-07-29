---
title: "The Config screen"
description: "Edit paddock.config.yaml from the UI: what's editable, why every change needs a restart, and why some fields are read-only."
---

Paddock's instance config lives in
[`paddock.config.yaml`](/configuration/config-file/), with
[environment variables](/configuration/environment/) layered on top. Since v0.42 you
don't have to hand-edit that file: the **Config** screen — the gear at the bottom of
the sidebar, at `/config` — reads the resolved config and writes the editable parts
back.

:::note[It used to be called "Settings"]
This link was labelled **Instance settings** from v0.42, shortened to **Settings** in
v0.46, and renamed **Config** — moving from `/settings` to `/config` — when the two
were pulled apart. Same screen throughout.

The rename is the point: **config** and **settings** are now different things, named
for the files they write.

| | Writes | Lifecycle | Where |
|---|---|---|---|
| **Config** | `paddock.config.yaml` | frozen at boot — **restart required** | `/config`, the sidebar gear |
| **Settings** | a workspace's `project.yaml` | hot-applied on save | that workspace's **Settings** tab |

Briefly, in v0.51.0, the root workspace's Settings tab rendered *both* — its own
settings with this screen stacked underneath, two save bars and all. That is what the
split fixed.
:::

## Three things to know before you click Save

### 1. Every change needs a restart

This is the big one, and the screen says so in a banner that never goes away.

Paddock resolves its instance config **once, at boot**, and freezes it. Saving writes
your changes to `paddock.config.yaml` on disk — it does **not** hot-apply them. The
running process keeps the config it started with until you restart it. After a
successful save the banner switches to a green "Saved to disk — these changes take
effect only after the server restarts" confirmation, which is the honest version of a
success message.

So the workflow is: change what you want, save, restart Paddock, verify.

### 2. An environment variable wins, and the screen tells you

Precedence is **env → file → built-in default**. A field that's currently pinned by a
`PADDOCK_*` variable renders **read-only**, showing the live value with an amber note:

> Overridden by environment variable `PADDOCK_SELF_MCP` — edit that env var (and
> restart) to change it.

That's not decoration. If the field were editable, saving it would write a value to the
file that the environment variable would go on silently ignoring — a change that looks
like it worked and doesn't. Making it read-only is how the precedence stays visible.

The corollary: if you want to manage an instance from this screen, don't also set that
knob in the environment. Pick one layer.

### 3. Some fields are display-only

The **Advanced** group is read-only by design: port, bind host, the data / projects /
state / scratch / web-dist paths, the herdctl config path, the auth mode, and the
GitHub client id. These are process and filesystem bindings — you change them by
changing how the process is *launched*, not from inside the running app.

Auth is deliberately read-only too. A misconfigured auth mode can lock everyone —
including you — out of the very UI you'd need to fix it, so v1 shows the mode and stops
there. Change it via the environment or the config file, where you can also fix it
without a browser.

## What you can edit

| Group | What's in it |
|---|---|
| **Curation** | The three [sweeper token budgets](/configuration/environment/#curation-sweeper-token-budgets) for `OVERVIEW.md`, `CHANGELOG.md` and `CLAUDE.md`. |
| **Sweeper** | Minimum interval between post-turn sweeps. Blank falls back to the 5-minute default. |
| **Capabilities** | Keeper drive mode, the [offered-model list](/configuration/models/), native system prompt, the three self-MCP gates, max spawn depth, schedule mutation, the hooks MCP, and the browser MCP. Most default off. |
| **Recovery** | The [keeper-chat recovery](/configuration/keeper-recovery/) layers and their guards. |
| **Attachments** | Inbound upload master switch, size and count caps, allowed types. |
| **Branding** | Name, logo, accent colour. |
| **Transcription** | Voice-dictation mode, model, endpoint. |
| **Git identity** | Author name and email for commits Paddock makes on a project's behalf. |
| **Logging** | Log level. |
| **Advanced** | Read-only — see above. |

Clearing an optional numeric field (leaving it blank) removes the key from the file, so
it falls back to the built-in default rather than being pinned to zero.

## Secrets are never in the response

No field on this screen carries a secret value. That isn't a masking rule applied at
render time — the secret-bearing settings simply aren't part of the surface at all, so
they can't appear in the API response in the first place. The transcription API key and
the JWT/JWKS internals are the notable absences.

Two settings are marked **sensitive** and shown read-only because they're
semi-revealing rather than secret: the auth mode and the GitHub client id.

Deliver real credentials the way you deliver any other runtime secret — a secrets
manager or a secrets file — not through this screen.

## What the write actually does to your file

If you keep comments in `paddock.config.yaml`, they survive. The write round-trips the
file through a YAML document parser rather than parse-then-restringify, so your
comments, key order, and any keys Paddock doesn't manage are all preserved. Only the
fields you changed are touched.

The write is **atomic** — a temporary file in the same directory, then a rename — so a
reader (or a crash) never sees a half-written config. If the file doesn't exist yet,
the first save creates it.

Validation happens server-side before anything is written: an unknown key, a read-only
key, or a value the loader wouldn't accept is rejected with a `400` naming the field
and the reason, and **nothing** is written. The rules mirror the config loader's own,
so the screen can't produce a file the loader would then quietly degrade.

Only fields you actually changed are sent, so a save is a patch, not a rewrite.

## See also

- [Config file (YAML)](/configuration/config-file/) — the file this screen edits, and every key in it.
- [Environment variables](/configuration/environment/) — the layer that overrides it.
- [Model allow-lists](/configuration/models/) — the "Offered models" field, in depth.
