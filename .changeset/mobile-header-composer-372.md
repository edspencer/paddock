---
"@paddock/web": patch
---

Mobile: collapse the stacked header into one row and tidy the composer (#372).

On phone-sized screens the project/chat view showed two rows of chrome — the
shell's brand bar (logo + instance name + hamburger) stacked above the project
header (name + status + new-chat + menu). The shell now drops its brand row on
project routes and the project header hosts the hamburger inline via an
`openNav` Outlet context, collapsing the two into a single row and reclaiming
vertical space. The brand still lives in the nav drawer the hamburger opens.

The composer typography is also normalized on mobile: the anti-iOS-zoom rule no
longer force-bumps `<select>` to 16px (it opens a native picker, so it never
triggered focus-zoom), so the small model dropdown matches its row again; the
Send/Stop buttons go icon-only below `sm` so the textarea keeps enough width for
its placeholder to sit on one line; and the "Preload project context" hint
(`(injects OVERVIEW.md + CHANGELOG.md)`) is hidden below `sm` — it's redundant
with the label's own tooltip — so that line no longer wraps. Desktop is
unchanged.
