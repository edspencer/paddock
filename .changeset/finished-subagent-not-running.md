---
"@paddock/web": patch
---

The running-work bar no longer lists a sub-agent from an earlier turn as "starting…" or running whenever a later turn streams. A finished sub-agent whose transcript poll never returned anything stayed in the bar for the whole of every later turn. Its own poll now decides, so a background sub-agent still working from an earlier turn stays listed.
