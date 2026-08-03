---
"@paddock/server": minor
---

Make the `paddock` CLI usable by someone who has never seen it (#638)

- **`--open`** launches the browser once the server is listening.
- **Quiet by default.** A first run printed ~30 lines of boot logging, scrolling
  the URL off the top of the terminal; it now prints 9, all of them meaningful.
  This needed **two** unrelated loggers told to hush — `LOG_LEVEL` for Paddock's
  pino logger and `HERDCTL_LOG_LEVEL` for `@herdctl/core`, which emits its
  `[fleet-manager] …` lines through `console.info` where pino's level cannot
  reach them. **`--verbose`** opts back in, and an explicit value for either
  variable is always respected.
- **`EADDRINUSE` and `EACCES` are explained**, not dumped. Port 4000 is popular
  and is also Paddock's default, so "address in use" is the likeliest first-run
  failure; the message now names the port and suggests `--port <n+1>`.
- **`--help` documents where your data lives** — that it is one directory, that
  it persists, and that moving or deleting it moves or resets the instance.

Also fixes a latent bug in `import-chats`: its run-directly guard compared
`import.meta.url` against `"file://" + process.argv[1]`, which leaves spaces and
non-ASCII characters un-encoded, so the script would silently do nothing when run
from such a path (the same trap as #636).
