---
title: Prompt injection and untrusted content
description: An agent can't reliably tell your instructions from instructions it read in a web page, a repo, or another chat. The routes untrusted text takes into a Paddock turn, and what actually helps.
---

[Securing Paddock](/guides/securing/) defends against someone reaching your instance.
[What your agents can do](/guides/agent-capabilities/) describes the authority a turn
holds. This page is the case where those combine badly: nobody breaks in, your agent
works exactly as designed, and the instructions it follows did not come from you.

## The problem, plainly

A Claude Code agent reads text and acts on it. It has no reliable mechanism for
distinguishing *"this is my operator's instruction"* from *"this is text I happened to
read while doing my job."* When both arrive in the same context window, an instruction
embedded in the content can be followed.

This is **prompt injection**, and it is a property of tool-using agents generally, not a
Paddock defect. Paddock's relevance is that it puts such an agent on a persistent host,
gives it `Bash` and your credentials, and then arranges for it to read things — on a
schedule, unattended, sometimes at your invitation.

The useful mental model is the **confused deputy**: the agent is not compromised, it is
being used, with its own legitimate authority, by whoever wrote the text it read.

:::danger[Paddock has no defence against this]
There is no filter, no instruction-provenance tracking, and no content sanitisation
anywhere in Paddock. Nothing here is mitigated by `PADDOCK_AUTH_MODE`, by the bind guard,
or by a reverse proxy — those sit in front of a door the content never walks through.

The realistic posture is **blast-radius management**: assume an injected instruction gets
to use everything the agent legitimately has, and make that set small.
:::

## The routes text takes into a turn

Every one of these is a documented, intended feature. That is the point — you cannot spot
the risky ones by looking for something that seems wrong.

### The web

`WebFetch` and `WebSearch` are on the
[default toolset](/guides/agent-capabilities/#the-default-toolset) for every project
agent. "Read this page and summarise it" puts a third party's text into a context that
also holds `Bash` and your Anthropic token.

`PADDOCK_BROWSER_MCP` widens this: a headless Chromium the agent drives, pulling
arbitrary rendered content — including text a page shows only to a browser — into the
same context. It is off by default, and that default is worth keeping.

### Repositories you cloned

This is the sharpest one, because a repo supplies more than prose.

For a **repo-backed project**, the checkout is a Claude Code settings source. That means
the repo can carry, and your agent will load on every turn:

- its own **`CLAUDE.md`**, which Paddock's sweeper deliberately leaves alone as
  upstream-owned — so it is standing instruction on every turn;
- a **`.claude/` directory**: settings, skills, slash commands, subagents — and
  `settings.json` can declare **hooks that execute shell commands on tool events**.

That last one is not prompt injection at all. It is direct code execution from the
repository, and it does not require the model to be fooled by anything.

> Whoever can merge to that repository can run commands on your box.

:::note[The host machine's hooks are a different question, and are now off by default]
The paragraph above is about a **repo's** `.claude/settings.json`, loaded because
the checkout is a project settings source. Your **own**
`~/.claude/settings.json` is a separate path, and since v0.62 its hooks do *not*
run inside Paddock turns unless you set
[`claude.hooks: host`](/configuration/config-file/#hooks). Before that they always
did, with no key to turn them off. Turning it on re-inherits every hook you have
configured — see [What Paddock touches on your
machine](/guides/what-paddock-touches/). Nothing about that key affects the
repo-supplied file described here, which no Paddock setting disables.
:::

For most people the upstream is their own repo and this is fine. It stops being fine for
a fork you don't control, a vendored dependency, or a repo an agent chose itself —
which is why `create_project` (gated by `selfMcpProjectsEnabled`, off by default) runs
`git clone` on an **agent-supplied URL** with no allow-list. Paddock's Management-API
policy layer classes the same operation as high-risk.

### Other chats

Transcripts are JSONL files in each project's `.chats/` directory. So `read_chat` (gated
by self-MCP read) is the *tidy* route, not the only one: any agent can `Grep` its own
project's entire history — one level above the checkout, for a repo-backed project — and
the **root workspace agent, whose working directory is `projectsRoot`**, can read every
chat on the instance with one command, regardless of any flag. On a shared instance, treat
every chat as readable by every agent.

### The sweeper, into standing instructions

Worth tracing carefully, because it is the least obvious.

After each turn the [sweeper](/concepts/sweeper/) reads a digest of recent chat activity
and rewrites the project's `OVERVIEW.md`, `CHANGELOG.md`, and — for **non-repo-backed**
projects — the *Curated notes* section of `CLAUDE.md`, wholesale. `CLAUDE.md` is
auto-loaded by Claude Code on every turn in that project.

So there is a path from **content in one chat** → the sweeper's prompt → **`CLAUDE.md`** →
**the standing instructions of every subsequent chat in that project**. The sweeper is
itself the narrowest agent Paddock runs, but it is a *writer*, and what it writes is read
by agents that do have tools. Its prompt also absorbs a project-controlled
`.paddock/hooks/sweep.md`, capped at 8,000 characters, and a curator trigger's prompt
file — and *that* one resolves inside the checkout for a repo-backed project, so upstream
can steer the sweeper too.

Nothing commits these edits for you. If your projects root is a git repo and you commit
regularly, `git log` on `CLAUDE.md` is a real audit trail; otherwise the previous content
is simply gone, since the section is replaced rather than merged.

### Everything else that arrives as text

- **Issue and PR bodies** — an agent running `gh issue view` is reading text written by
  anyone who can open an issue. On a public repo, that is anyone.
- **Scheduled work that fetches something** — a nightly trigger running `gh pr list` or
  `WebFetch` reads content nobody looked at first, at a time nobody is watching.
- **Attachments and uploaded files** — `allowedTypes` is described in Paddock's own source
  as *"a hygiene/UX guardrail, NOT a security boundary"*, and invalid input falls back to
  the instance default (allow-all out of the box).

## Why tool grants don't rescue you

The instinct is to scope the agent's tools. That instinct is right, and you should — but
be clear about how much it buys. The project agent's toolset
[isn't configurable at all](/guides/agent-capabilities/#the-default-toolset), and where
you *can* scope, [the grant isn't yet enforced](/guides/agent-capabilities/#scoped-agents-triggers-and-hooks)
— including the trap that an empty tool list is passed to the runtime as *no* list.

And the deeper problem survives both: **the agent needs the dangerous tools to do the
job.** An agent that reviews PRs needs to read PRs and run tests. You cannot separate
"read the untrusted thing" from "have the capability" by wishing.

So tool scoping is a good default and a bad last line of defence.

## What actually helps

Ordered by how much they buy you.

**Don't let untrusted content and privileged credentials meet in the same instance.**
The strongest available separation is a **second Paddock instance** — its own data
directory, port, OS user and credentials — not a second project. A project is not a
boundary: project agents have `Bash` and no confinement, so they can read each other's
files and each other's transcripts. [A home-lab setup](/guides/home-lab/) describes
running more than one.

**Scope the credentials — and know which one you can't.** A fine-grained GitHub PAT
limited to the repos this instance should touch binds regardless of what the agent
decides: an injected instruction to push elsewhere simply fails. The **Anthropic**
credential is different — the agent needs it, so it cannot be scoped away. Give the
instance its own API key so you can revoke it without collateral, and set a spend limit
on that key, since Paddock enforces none.

**Trust the upstream of any repo-backed project the way you trust a CI runner.** Its
`CLAUDE.md` is standing instruction and its `.claude/settings.json` can run commands.
Review what a new checkout brings with it before pointing an agent at it.

**Make it recoverable.** Branch protection plus required PRs on every repo the token can
reach means the worst an agent's push can do is open a branch you delete. Back up the
data directory and test a restore. Rehearse revocation once — Anthropic key, GitHub PAT,
`PADDOCK_MCP_TOKEN_*`, stop the service — so you can do it from your phone.

**Keep the risky capability flags off.** `selfMcpProjectsEnabled`, `hooksMcpEnabled` and
`browserMcp` all default off; set them via environment variables if you want them to stay
that way. Each one turns "the agent read something bad" into a larger event.

**Know how you'd notice.** See
[How you would know](/guides/agent-capabilities/#how-you-would-know) — especially the
`CLAUDE.md` diff and your Anthropic usage graph.

**Consider `docker: true`** — but read
[the constraint first](/guides/agent-capabilities/#docker-isolation). It only applies on
the batch path, and it isolates the filesystem, not the network or your Anthropic
credential.

## What would help, and doesn't exist yet

- **No sandbox.** Per-agent filesystem confinement is
  [#7](https://github.com/edspencer/paddock/issues/7), open.
- **No enforced tool boundary.** [#319](https://github.com/edspencer/paddock/issues/319),
  open.
- **No environment filtering.** Agents inherit the server's credentials.
- **No content provenance.** Nothing marks a span of context as "this came from the web".
- **No egress control.** If you need it, it belongs at your network layer.

## Checklist

- [ ] Repo-backed projects point at repositories whose **merge access you trust** — their
      `CLAUDE.md` is standing instruction and their `.claude/settings.json` can execute
      commands.
- [ ] Sweeper-written changes to `CLAUDE.md` get reviewed (non-repo-backed projects only —
      the sweeper leaves a repo's own file alone), and your projects root is actually
      committed so there's a diff to review.
- [ ] Work that reads third-party content is **separated at the instance level**, with its
      own credentials — not merely a different project on the same box.
- [ ] `browserMcp`, `selfMcpProjectsEnabled` and `hooksMcpEnabled` are off unless
      deliberately needed.
- [ ] You have written down, somewhere you'll find it again, what this instance's
      credentials could destroy — and confirmed you could revoke them all in five minutes.

The capability-side checklist — toolset, permission mode, flags, spend, backups — is on
[What your agents can do](/guides/agent-capabilities/#checklist).
