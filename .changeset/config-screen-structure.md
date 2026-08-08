---
"@paddock/web": patch
---

The instance **Config** screen is restructured. Its navigation (a scroll-spying
section rail over one searchable document) was right; its layout was not, and the
layout is what made the screen hard to read in either mode.

**One measure.** Four unrelated left edges used to stack down the page — a
full-bleed header, a rail at x=0, a filter bar flush to the right column, and a
content column centred *inside* that column, so it lined up with nothing and sat
optically off-centre in the window. The filter bar, the document and the save bar
now hold the same measure. The save bar moved inside the document column to get
it: a footer that also spans the rail can never put Save on the content column's
right edge.

**A surface.** The screen used the app's card primitive zero times — fields sat
on the bare canvas divided by hairlines, while the *other* settings screen carded
every group, so the two read as different products. Both now render through the
same `Section`, and `SettingsPane`'s local copy of it is deleted.

**Rows, not a ragged grid.** `sm:grid-cols-2` sizes each row by its tallest cell,
and help text here runs from zero lines to three, so nearly every row left a dead
gap beside it. Fields are one column now — label and help left, control
right-aligned in a fixed slot — so every control's right edge agrees down the
page and no row can be ragged against another.

**A dirty marker that doesn't move the field.** It was `-ml-2.5 border-l-2 pl-2`,
which shoved an edited field 10px out of its own grid track and hung the accent
bar into the gutter: the one cue on the screen that actively broke the alignment.
It is an absolutely-positioned bar on the card's inner edge now, so it costs no
layout.

**One set of controls.** A boxed input, a bare monospace value and a hand-rolled
switch that existed nowhere else in the app have all been routed through
`components/ui`. A read-only value keeps an input's box metrics — a sunken fill,
no border — so locked and editable rows line up while a value still reads as a
fact rather than a control you are being denied.

Also: the section rail was `hidden lg:block`, so below 1024px the screen lost the
navigation its whole flat shape was justified by and handed the window back a
5,500px scroll — the same links now run horizontally under the filter at those
widths. And on a containerised instance an amber `env` chip plus an amber
variable name, twenty times over under a permanently amber banner, made the page
shout; both are quiet now, because being set from the environment is a fact about
a field rather than a warning about it. The restart banner stays loud. It earned
it.
