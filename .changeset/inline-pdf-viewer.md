---
"@paddock/server": patch
"@paddock/web": patch
---

feat: inline PDF viewer for agent-sent files (#128)

A `.pdf` sent via `mcp__paddock__send_file` (`file_path`) now renders inline in
a scrollable viewer instead of decoding its bytes as UTF-8 garbage in a `<pre>`.

- Server infers `kind: "pdf"`, serves the bytes as `application/pdf`, and drops
  the `sandbox` CSP for PDFs (a bare `sandbox` stops the browser's native viewer
  from painting) while keeping `default-src 'none'` so nothing inside the PDF can
  script or phone home. Inline `content` PDFs are rejected (binary needs a file).
- Web renders a native `<object>` viewer (no pdf.js / new deps) with an
  open-in-new-tab + download fallback for browsers that can't inline a PDF.
