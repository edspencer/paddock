---
"@paddock/server": patch
---

Narrow the keeper's over-broad `rm -rf` deny rule (#179). The default
`denied_tools` list carried `Bash(rm -rf /*)`, whose trailing `*` made it a
prefix match on `rm -rf /` — so it denied **every** absolute-path delete,
including the keeper cleaning up its own scratch/clone dirs
(`rm -rf /tmp/foo`, `rm -rf /var/lib/.../clones/x`), while giving false
security (a relative `rm -rf clones/x` sailed straight through). The rule is
replaced with a narrow, honest set of catastrophic root/home/system-dir
patterns (`rm -rf /`, `rm -rf / <args>`, `rm -rf ~`/`$HOME`, and bare top-level
system dirs matched exactly) that leaves legitimate absolute-path cleanup under
project/tmp roots untouched. `sudo *` and `chmod 777 *` are unchanged. This
denylist is best-effort defence-in-depth, not a sandbox — real per-agent
filesystem isolation is tracked separately (#7).
