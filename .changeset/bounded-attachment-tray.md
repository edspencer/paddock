---
"@paddock/web": patch
---

Bound the composer's attachment tray so the message box stays reachable (#909).

With `attachments.maxFilesPerMessage` raised, staging a large batch of files grew
the tray until it pushed the textarea and Send button out of the viewport — and
because every ancestor up to `<body>` is `overflow-hidden`, there was no scroll
container able to bring them back, at any zoom level. The tray now caps at
`min(9rem, 28vh)` and scrolls its own overflow, so the composer keeps its place
however many files are staged. Two or more files also get a summary bar with a
**Clear all** button, instead of only being removable one at a time.
