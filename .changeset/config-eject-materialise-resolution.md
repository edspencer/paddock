---
"@paddock/server": minor
---

`paddock config eject` (#878): materialise the resolved configuration into
`paddock.config.yaml`, for people who want it frozen and written down rather
than inherited.

This is the other half of the argument `config show` makes. A thin file plus a
printed resolution is the better default — it cannot drift, and it can show you
the variables your container sets on top. But "pinned in git, reviewable in a
diff, identical across a fleet, and unaffected by what a later release decides a
good default is" is a legitimate want that `show` does not serve. So eject
exists, and its job is not just to write the file: it is to make the tradeoff
visible **at the moment someone reaches for it**, rather than only in docs read
once.

**It previews by default; `--write` applies it.** Ejecting is the one config
operation that changes what the file *means* rather than what it says, and it
spreads that change over ~forty keys where no single one looks like a decision.
So the default run prints every key it would write, the layer each is being
frozen out of, what is deliberately being left out, and what it costs — naming
the two keys where staleness bites hardest with their actual contents (`models`
pins today's catalog; `environmentPrompt` pins today's text). A flag rather than
an interactive confirm, because the likeliest caller is a container build or a
config-management task that cannot answer a prompt.

**A value an environment variable supplies is skipped, and the variable named.**
This is the subtle one. Env beats file, so freezing an env-sourced value changes
*nothing observable today* and changes the instance on the day that variable
stops being set — a deferred, silent transfer of a decision out of the
environment into a file, with no record it was ever an environment decision. It
is also how a stray `PADDOCK_*` left on a build box gets baked into a committed
config permanently. There is precedent: the Settings PUT path already refuses to
write a key an env var shadows. `--include-env` writes them anyway, which is
correct for the one case that genuinely wants it — deliberately migrating an
instance off a wall of variables and into a file.

**`profile:` is written even so**, and that exception is the point rather than an
inconsistency. After a full eject the line governs no key that exists — every one
is explicit — so it cannot change a current value. Its only effect is on a lever
added in a *future* release, which without it would resolve against the built-in
default profile rather than the posture actually frozen. Ejecting from `paranoid`
and silently acquiring `balanced`'s answer to an unheard-of lever is precisely
the drift this command is meant to prevent.

Two more things it will not write. **Machine-specific bindings** — `port`,
`host`, `dataDir` and friends — because they resolve to absolute paths on one
machine, `dataDir` resolves to the directory holding the file itself, and a
frozen port is how a second instance started from the same file collides on
boot. And **`sensitive` fields**, unconditionally and with no flag:
`transcription.endpoint` is an operator-supplied URL that can read
`https://user:token@host`, and bulk-writing a credential-shaped value to disk
should not be one keystroke away. Neither omission can change what the instance
resolves, which is what makes them safe rather than merely defensible — a
sensitive value can only have come from the file (already there), the environment
(skipped anyway), or its default (nothing to write).

The write reuses the Settings screen's comment-preserving atomic writer, so
operator comments and unmanaged keys survive and the file is round-tripped rather
than regenerated. Keys the file already sets *and* already wins with are left
untouched, so the diff is minimal and a hand-written line keeps its formatting; a
file value that is **not** in effect — inert under another key's cascade — is
replaced with the one that is, removing a false claim from the file. Re-running
on an already-ejected instance reports `Nothing to write`, which makes it the
quickest check for whether an upgrade added a lever.

The property all of this rests on is pinned by tests that run the real loader and
the real writer: **an ejected file resolves to exactly what the instance resolved
before it was written.** Under each of the three profiles, with `PADDOCK_PROFILE`
then removed entirely, all 46 fields still resolve identically — only the layer
moves, from `profile` to `file`.
