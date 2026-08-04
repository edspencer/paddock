---
"@paddock/web": patch
---

Fix an expanded `send_file` card flickering forever and breaking chat scrolling

A sent file taller than 360px re-rendered **once per animation frame, for as long
as it was on screen**, strobing between its bounded (360px, scrollable) and
unbounded (full-height) layouts. Because the transcript's height changed by the
same amount every frame, scroll anchoring fought it and scrolling the chat became
unusable.

`ResizableBox` returned two structurally different trees for the two cases, so
React reused one host `<div>` for both roots — and the `ResizeObserver`, whose
effect never re-ran (its only dependency is the parent-owned `children`), kept
measuring that node after it had become the wrapper carrying `style.height`. The
measurement was therefore circular: it read back the applied height, `360 > 360`
was false, the box unbounded itself, measured the full height, bounded itself
again, forever (#656).

The tree shape is now the same in both cases — bounding only toggles classes and
attributes — so the measured element is always the content, which nothing sizes.
That also stops `children` being remounted on every flip, which is what left an
async Mermaid render inside a long markdown body permanently blank (#644).
