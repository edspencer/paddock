---
"@paddock/server": patch
---

Paddock is MIT licensed, and the packaging script now proves it (#674)

The repo had no `LICENSE` file and no `license` field in any manifest — legally,
all rights reserved — while `scripts/make-npm-package.mjs` carried a
`license: serverPkg.license ?? "MIT"` fallback, so every published release told
npm it was MIT. The registry advertised a grant the source never made.

Now there is a real `LICENSE` (MIT, © 2026 Ed Spencer) at the repo root,
`"license": "MIT"` in the root, server, and web manifests, and the licence text
ships inside the published tarball and the release tarball. The fallback is
gone: the packaging script reads the real field and **exits non-zero** if it is
missing or blank, so a Paddock package can never again claim a licence the repo
did not grant.
