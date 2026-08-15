---
"@paddock/server": minor
---

`paddock config show` (#878): print what an instance's configuration actually
resolved to, and which layer each value came from.

Profiles let a config file stay thin — a posture name plus the handful of levers
you disagree with — which raises a fair question the file can no longer answer:
*so what am I actually running?* The tempting answer is to materialise every
value back into the file. That is a snapshot: it stops inheriting improved
defaults, goes stale the day a lever is added, and says nothing about the
variables your container sets on top of it. `config show --resolved` is computed
by the same loader the server boots with, so it cannot drift from what the
process would actually do.

Provenance is the deliverable, not the values — the Config screen already shows
you values. What nothing showed you is the **layer**, which is what tells you
where to go to change something. Every row is labelled `default`,
`profile (<name>)`, `file` or `env <NAME>`.

**`profile` is deliberately not folded into `default`.** For the twelve posture
keys there is no code default any more; the profile supplies it. Collapsing the
two would leave you unable to tell "Paddock has always shipped this" from "your
profile chose this, and switching profile would change it" — which for a set of
security levers is the whole question. It is also how the precedence inversion
profiles introduced becomes visible rather than merely documented: a `claude.hooks`
row reading `file` next to a `Profile  yolo` header is the file beating
`PADDOCK_PROFILE`, shown rather than described.

Both views also list any key your config file sets that is **not** in effect,
naming what beat it — an environment variable for the same key, or another
setting's cascade. "I edited the file and nothing changed" was previously
undiagnosable from anywhere.

Bare `paddock config show` prints the **decisions**: your profile, the keys your
file sets, the variables your environment sets. That mirrors the shape profiles
argue for — thin by default, explicit on demand — and avoids the two bad
alternatives, a no-argument command that errors at you and one that dumps forty
rows and makes `--resolved` pointless. Both are readings of one report, so they
cannot disagree.

Three smaller decisions worth knowing:

- **It creates nothing.** Inspecting an instance must not bring one into being,
  so the loader's data-dir `mkdir` is skipped; a missing directory is reported as
  missing. Otherwise running this on a machine that has never started Paddock
  would leave an empty `~/.paddock` behind and the first-run welcome, which keys
  on that directory's absence, would never print.
- **Fields marked sensitive print as `(hidden)`**, with `--show-sensitive` to
  reveal them. The field table documents itself as never carrying a secret, but
  that is an intention maintained by hand rather than an enforced invariant — and
  one field it already marks is `transcription.endpoint`, an operator-supplied URL
  that can perfectly well read `https://user:token@host`. This output is designed
  to be pasted into an issue.
- **A malformed config file exits non-zero** with the same error `paddock start`
  would fail on, rather than printing a partial report. The honest answer to "what
  is my config?" when the file will not parse is "your instance would not boot".

Also `--json` for the whole report machine-readably, and `-d/--data-dir` to
inspect an instance other than the default — resolved by the same function
`paddock start` uses, so the two can never read different instances.
