---
version: "0.1.2"
level: copilot
processes:
  design: pair
  implementation: copilot
  testing: copilot
  documentation: copilot
  review: copilot
  deployment: assist
---

This format is based on [AI-DECLARATION.md](https://ai-declaration.md/en/0.1.2).

## Notes

Paddock is a web UI for Claude Code, and it was built with Claude Code — mostly
inside Paddock itself. I rarely open the CLI any more. **383 of its 666 commits
carry a `Co-Authored-By: Claude` trailer.**

- **Design is mine.** The core models — projects, chats as resumable Claude Code
  sessions, the spawn tree, the storage layout, the auth boundary — are decisions
  I made and argued through with Claude rather than delegated. The `DESIGN-*.md`
  documents under [`docs/`](docs/) are the record of that.
- **Implementation is largely generated under review.** I prompt, Claude writes,
  I read the diff and the PR.
- **Review is partly agentic too.** Pull requests here are also reviewed by
  Warren, an Opus-based reviewer built on [herdctl](https://github.com/edspencer/herdctl).
  I read its output; it does not merge anything.
- **Everything lands through CI**: typecheck, 268 unit and integration test files,
  and 24 Playwright end-to-end specs that drive the real server, the real
  FleetManager and the real CLI runtime, with only the model swapped for a fake
  `claude` on `PATH`.
- I use Paddock every day to build Paddock. When it breaks, it breaks for me
  first.

### Why this file exists

Because "was this vibe-coded?" is a fair question to ask of a project like this,
and the useful answer is a specific one rather than a defensive one. If you are
sceptical of generated code, this tells you exactly where to look.
