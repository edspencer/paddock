---
"@paddock/web": patch
---

Cut the CPU cost of a streaming chat. While a turn streams, the only continuous
work is a handful of 60fps CSS animations (two spinners + a ping) — measured with
0 JS long-tasks and ~1 DOM mutation/sec — which on a large/Retina display can pin
the OS compositor near 50% for the whole turn. The "working" spinners now use a
stepped, layer-isolated `spin-eco` (~10fps instead of 60) rather than a smooth
`animate-spin`; the streaming caret hard-blinks instead of a smooth opacity pulse;
the redundant `animate-ping` dot is dropped; and all of these honor
`prefers-reduced-motion` and pause while the tab is backgrounded.
