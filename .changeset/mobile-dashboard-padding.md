---
"@paddock/web": patch
---

Shrink the Projects dashboard padding on mobile. The landing grid wrapped in
`px-8 py-10` at every width, spending 64px (16% of a 390px phone) on side
gutters. It's now responsive — `px-3 py-5` on XS, restoring `px-8 py-10` at the
`sm` breakpoint and up.
