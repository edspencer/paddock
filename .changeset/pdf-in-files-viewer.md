---
"@paddock/server": patch
"@paddock/web": patch
---

Render PDFs in the Files and Changes tabs instead of dumping their bytes as text
(#917). Opening a `.pdf` in the file viewer showed pages of mojibake: `fileKind()`
had no branch for it, so it fell through to `text` and the server UTF-8 decoded
the binary, turning every invalid byte sequence into `U+FFFD`.

`.pdf` now gets its own render kind. The JSON path returns empty `content` and
stats the file (as it already did for images), the bytes come from the raw
endpoint, and the viewer is the same native-`<object>` embed that agent-sent PDFs
have used since #128 — now shared, so both surfaces stay in step. Browsers that
won't inline a PDF keep the open-in-new-tab/download fallback.

The raw byte endpoints for project files and untracked files now choose their
Content-Security-Policy per MIME via `cspFor()` rather than hard-coding
`sandbox; default-src 'none'`. A bare `sandbox` token stops the browser's native
PDF viewer painting at all, so without this the embed renders an empty frame. Only
`application/pdf` and `video/*` drop the token; every other type — images, SVG,
HTML — keeps the locked-down CSP exactly as before.
