---
"@paddock/server": patch
---

`paddock service install` no longer prints a linger line when `loginctl` can't answer; it prints the `sudo loginctl enable-linger` line only when linger is off, as CLI contract 1.0 (§7) says. `doctor` still reports that case as a skipped check. The copied reference files now name contract 1.0 in their headers.
