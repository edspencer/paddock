---
"@paddock/server": patch
---

`serve`'s first stdout line is the banner, because the conformance runner said it wasn't

Paddock now runs [`@edspencer/cli-conformance`](https://github.com/edspencer/cli-contract)
in CI, which checks the CLI contract from the outside — and it immediately
failed a check that nothing else could see.

- **The server's logs now go to stderr, not stdout.** Boot logging happens
  before the server can know it has bound, so on any machine with no Claude
  login — every CI runner, every fresh install — `serve`'s first stdout line was
  `{"level":40,…,"msg":"no Claude credentials found…"}` rather than
  `Paddock <version>: <url>`, which is the line a script reads to find the URL.
  Nothing loses the logs: Docker and Kubernetes collect both streams, and the
  service units send both to the same file. A log shipper configured for stdout
  **alone** is the one thing that changes.
- **The first-run "Welcome to Paddock" notice also goes to stderr**, for the same
  reason: it is prose for a person, and it appeared on exactly the run a script
  would be parsing.

`cli-contract.json` at the repo root records which checks apply and why `busy`'s
two do not yet (wave C1). Seven pass, two are skipped with a reason.
