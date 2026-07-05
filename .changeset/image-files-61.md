---
"@paddock/server": patch
"@paddock/web": patch
---

Render image files in the Files & Changelog tab instead of mangled binary text
(#61). Images had no render kind and the file path read every file as UTF-8, so
a `.png`/`.jpg`/etc. showed replacement-character mojibake.

Adds an `image` `FileKind` (png, jpg/jpeg, gif, webp, avif, bmp, ico, svg), a
raw-bytes endpoint (`GET /api/projects/:slug/files/:name?raw=1`) that streams the
file with the correct `Content-Type` (keeping the path-traversal guard), and an
`<img>` branch in the file viewer that loads from it. Image bytes are no longer
UTF-8-decoded. Byte responses carry a locked-down CSP (`sandbox; default-src
'none'`) + `nosniff` so a directly-opened SVG/HTML file can't execute script in
the app's origin.
