---
"@paddock/server": patch
"@paddock/web": patch
---

ci(release): also attach a stable-named `paddock-latest.tgz` (+ `.sha256`) to
each GitHub Release, alongside the existing pinned `paddock-<version>.tgz`.

GitHub's `releases/latest/download/<asset>` redirect only resolves when the
asset filename is identical across every release, so the version-named tarball
could never be fetched that way — the natural-looking
`releases/latest/download/paddock-latest.tgz` 404'd. The release job now uploads
an identical copy of the tarball under the fixed name `paddock-latest.tgz`, so
that URL always points at the newest release. Self-hosters and deploy recipes
can pick a floating (`paddock-latest.tgz`) or pinned (`paddock-<version>.tgz`)
download. Fixes #454.
