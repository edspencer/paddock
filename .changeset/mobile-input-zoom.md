---
"@paddock/web": patch
---

Fix mobile input focus-zoom and add safe-area chrome. iOS Safari auto-zoomed
(and broke the fixed 100dvh layout) whenever a sub-16px input/textarea was
focused; form controls are now 16px on small screens, so focus-zoom is
prevented without disabling pinch-to-zoom. Also adds `viewport-fit=cover` with
`env(safe-area-inset-*)` padding on the mobile top bar and composer (no longer
tucked under the notch / home indicator), removes the grey tap-highlight flash
on interactive controls, and sets `autoCapitalize="sentences"` on the composer.
