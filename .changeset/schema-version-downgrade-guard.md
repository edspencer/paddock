---
"@paddock/server": minor
---

`project.yaml` and `paddock.config.yaml` now declare a `schemaVersion`, and
Paddock refuses to lenient-parse a file written by a newer version of itself
(#724).

The motivating problem is not migrations, it is **downgrades**. Running an older
Paddock — `npx @edspencer/paddock@0.62.0` is one command away — against a data
dir a newer one wrote used to read it leniently: the project normaliser drops
every key it does not recognise, and the next save writes the file back without
them. A `path:` or a `managed:` disappeared with no error and no way to notice.

The two on-disk formats Paddock owns now carry `schemaVersion: 1`, and a file
declaring a version this build does not understand is never lenient-parsed:

- **`paddock.config.yaml` from the future → refuse to start**, naming the file,
  both versions, and the fix. Fail-closed, in the same shape as the existing
  refusal when the Claude home resolves to your own `~/.claude` — an instance
  config decides auth mode and bind host, and half-understanding those is worse
  than not booting.
- **A `project.yaml` from the future → that project is skipped, loudly**, with a
  startup warning naming the file and its version; the rest of the instance is
  unaffected and the file is left byte-for-byte alone. Deliberately *not* a
  refusal: an unreadable `project.yaml` already made a project vanish silently,
  so saying it out loud is a strict improvement, whereas bricking a whole
  instance because one project directory was copied in from a newer box would be
  a worse failure than the data loss being prevented.

**Adoption touches no existing data.** The current on-disk shape *is* version 1
and an **absent** `schemaVersion` reads as 1, so every file on every live
instance already reads correctly and nothing is rewritten. Files Paddock writes
from now on carry the field explicitly; existing ones pick it up whenever they
are next saved for some other reason. There is no backfill pass, and merely
reading a file still writes nothing to it.

No migration runner ships with this — with `1` as the only version there is
nothing to migrate, and one with zero migrations cannot be meaningfully tested.
The rule for when to bump the number (monotonic integer, never semver; adding an
optional key does **not** bump) is documented next to the constants in
`schema-version.ts`.
