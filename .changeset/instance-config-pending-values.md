---
"@paddock/server": patch
"@paddock/web": patch
---

The `/config` screen can now tell you what is actually in `paddock.config.yaml`
(#722), and a `null` on a numeric field clears the key instead of writing `0`
(#723).

**One root cause behind three symptoms (#722).** `buildInstanceConfig` built the
GET response out of the boot-frozen `PaddockConfig` and never read the config
file, so `GET /api/instance-config` could not observe *any* write — including one
the same client had just made a millisecond earlier. Everything followed from
that:

- **A successful save appeared to revert.** The form re-fetches after writing and
  clears its dirty set; the re-fetch returned the pre-save values, so setting
  *OVERVIEW.md max tokens* to `1234` wrote `1234` to disk, showed a green "Saved
  to disk", and put `2000` back in the box.
- **Two tabs silently last-writer-won.** Tab A saving `1111` left tab B still
  displaying `2000` with nothing — not polling, not an ETag — able to reveal it,
  because the value B would have polled for was never read from the file.
- **`restartRequired` was hardcoded `false`**, so nothing ever said that the file
  had diverged from the running process.

The DTO now carries **two** values per field: `value` (in force now, out of the
frozen config) and `pendingValue` (what the file says this instant, i.e. what a
restart would load), plus `pendingRestart` where they differ. The editor binds to
`pendingValue` — it is an editor for the file — so a save round-trips, another
tab's write is visible on the next load, and the field says what is still in
force. `restartRequired` falls out as "some field diverges" rather than being
asserted.

Pending values are computed for editable, non-env-shadowed fields only: an
env-shadowed field resolves to the same env value after a restart, and the
read-only `advanced` bindings are normalised at boot (paths canonicalised, `port`
`Number()`-ed), so comparing them against raw file text would report divergence
that isn't there. A file that exists but won't parse is reported as
`configFileError` instead of being silently read as "nothing pending" — the
screen that exists to fix a broken config should say it is broken.

**Saves are conditional.** The GET returns a `configVersion` (a fingerprint of
the file) which the UI echoes back as `expectedVersion`; a write composed against
a stale snapshot gets a 409 and the file is left alone, instead of the second tab
quietly erasing the first. The client keeps the operator's edits, reloads, and
lets them save again deliberately. `expectedVersion` is optional, so a script or
`curl` writes unconditionally as before.

**`null` on a `nonNegInt` field now clears the override (#723).** The PUT
contract is that a `null` deletes the key; `nonNegInt` used `Number(raw)`, and
`Number(null)` is `0` — a finite, non-negative integer — so
`{"recovery.maxRetries": null, "recovery.debounceMs": null}` wrote zeros. Those
are not a no-op: `maxRetries: 0` stops chat recovery retrying at all. The
validator now has the same explicit `null` / `""` / `undefined` branch as its
`optNonNegNumber` sibling, and a deliberate `0` still works. `maxSpawnDepth` had
the same hole (a "clear this" wrote depth 0, which switches off every child's
self-MCP) and is fixed with it.

The same missing type check let `Number()`'s coercions through: `true` wrote `1`,
`[7]` wrote `7`, `false` wrote `0`. Numeric fields now take a number or a numeric
string and nothing else.

**Two smaller holes found in the same audit.** Writing a field that a `PADDOCK_*`
env var currently shadows returned 200 + `restartRequired: true` for a write that
could never take effect (the UI already rendered those read-only; the API did
not) — it is now a 400 naming the variable. And numeric and string fields had no
upper bound: a 200 KB `brand.name` produced a 200 KB `paddock.config.yaml` that
every boot then had to parse. Numbers are capped at 1e9, plain strings at 1024
characters, list fields at 64 entries (the prompt-shaped `environmentPrompt`
keeps its own, much larger 32 KiB cap).

None of the existing validation is relaxed: negative/zero/fractional budgets,
bad enums, unknown/read-only keys, unknown model ids, non-hex colours, NUL bytes
and oversized prompts are all still rejected, and the file still round-trips
through the `yaml` `Document` API with operator comments intact.
