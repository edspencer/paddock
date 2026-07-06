---
"@paddock/web": patch
---

Lock document scroll on mobile so the app chrome no longer drags with the page.
The UI is a fixed-height shell whose panes scroll internally, but the document
itself was still scrollable — so on mobile Safari a swipe that started on the
"fixed" top bar or composer rubber-band-scrolled the whole page. Lock
`overflow` + `overscroll-behavior` on html/body (and keep momentum inside the
transcript with `overscroll-contain`); only the inner panes scroll now.
