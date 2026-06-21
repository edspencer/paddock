# Paddock — morning summary ☕

Built overnight. **It's live and working.**

## TL;DR

**https://projects.valfenda.net** — a project-first launchpad on herdctl. Projects
are the first-class citizen; one-off chats are secondary. Server-hosted, persistent,
resumable Claude Code sessions per project — a web replacement for your Zellij tabs.
Running on your **Claude Max** auth, valid TLS, on a dedicated LXC. Open it.

## What works (all verified end-to-end in a real browser on the live URL)

- **Projects grid** with "+ New Project", seeded with 4 of your real projects
  (Garage Water Heater, Multi-Zone AC, Garden Irrigation, UK TV / Media — empty,
  ready for you to start).
- **New Project** (name, domains, summary) → creates a dir + a herdctl keeper agent.
- **Chat inside a project**: streaming markdown, collapsible tool-call blocks, the
  session appears in the project's list on completion. **Resume works** (continues
  the same Claude session). Reload → history hydrates from disk.
- **Manage**: edit project metadata, delete project, delete chats.
- **One-off chats** (`/chat`, the "scratch" project) — secondary, as intended.
- Self-hosted fonts (renders right even offline on the LAN). Dark mode.

Screenshots: `docs/screenshots/` (`live-final-*.png` are the live site).

## What I built

1. **`paddock`** (private repo: github.com/edspencer/paddock) — npm-workspaces
   monorepo: `packages/server` (Fastify + WS, wraps `@herdctl/core@5.10.1` +
   a Project layer) and `packages/web` (React/Vite/Tailwind, project-first SPA).
   Built on the **public** herdctl release, per your steer.
2. **Deployed** to LXC `projects` (CTID 123, 192.168.1.83, pve-1), systemd
   `paddock.service` (enabled on boot), behind Caddy on netops, DNS via Unbound.
   All infra changes were backed up + validated; existing services unaffected.
3. **herdctl improvements, PR-ready (NOT pushed)** — in an isolated worktree
   `~/Code/herdctl-wt-paddock`, branch `feat/programmatic-agents`: `addAgent`/
   `removeAgent`, `getAgentSessions`/`getAgentSessionMessages`, and a
   `SDKMessageTranslator` in `@herdctl/chat`. Full green gates + tests + changeset.
   PR text in `~/Code/herdctl-wt-paddock/PADDOCK-PR.md`. Your primary `~/Code/herdctl`
   checkout was never touched (still on `feat/mcp-host-bridge`). **You push it when
   you're happy.**

Full build history + decisions: `JOURNAL.md`. Deploy details: `../paddock-deploy-notes.md`.

## Architecture (how a "project" maps to herdctl today)

A project = a directory under `/var/lib/paddock/projects/<slug>/` (project.yaml +
CHANGELOG.md) + a generated herdctl **keeper agent** (`working_directory` = that dir,
`runtime: cli`, Max auth). A chat = a herdctl session for that agent. Because the
public API has no programmatic `addAgent`, paddock generates per-agent yaml +
`fleet.reload()` (proven reliable). The `addAgent` PR above removes that round-trip
once merged + published.

## Heads-up / decisions I made (your call to change)

- **No auth on the app** — anyone on the LAN/Tailscale can use it. Fine for a
  homelab POC; add basic auth before you'd ever expose it wider.
- **Keeper agents run WITHOUT Docker isolation** (acceptEdits + denied dangerous
  bash). The LXC has `nesting=1` ready — Docker-per-project is the #1 hardening
  follow-up. (We'd discussed Docker-isolated; I deferred it for POC reliability.)
- Still on **public herdctl**, not the local build. Switching paddock to consume
  the local build (to use `addAgent` etc.) is a clean follow-up once the PR lands.
- `/opt/paddock.bak` (251M) left on the LXC as a rollback net —
  `ssh projects 'rm -rf /opt/paddock.bak'` when you're confident.

## Suggested next steps (in priority order)

1. Review + push the herdctl PR (`feat/programmatic-agents`).
2. Docker-isolate keeper agents (hardening) + add basic auth.
3. Point paddock at the local/merged herdctl build → adopt `addAgent`/`getAgentSessions`.
4. Auto-curate project CHANGELOGs from session activity (the original idea).
5. Session rename; code-split the web bundle; per-project settings.

## Run / manage

- Service: `ssh projects 'systemctl status paddock'` · logs: `journalctl -u paddock -f`
- Redeploy: tar `/Users/ed/Code/paddock` → LXC `/opt/paddock`, `npm run build`,
  `systemctl restart paddock` (see `../paddock-deploy-notes.md` §9 for the exact flow).
- Local dev: see `DEV.md`. Live e2e: `BASE_URL=https://projects.valfenda.net node scripts/live-final-verify.mjs`.
