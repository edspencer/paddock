---
title: Who Paddock is for
description: Paddock is for anyone who wants a capable, always-available agent working on their projects — not just software engineers.
---

Paddock happens to be built by a software engineer, and it works beautifully for
code. But it is **not only for code.** At its heart Paddock is a way to give any
project a persistent, capable agent you can reach from anywhere — and a project can
be almost anything.

## It's a launchpad, not an IDE

A **project** is just a directory with an agent attached. That agent (the *keeper*)
can read and write files, run commands, use tools, and hold a long, resumable
conversation about the work. What the work *is* is up to you:

- **Code** — a repo-backed project where the keeper builds, tests, and opens PRs.
- **Research & notes** — a notebook project where the keeper gathers, summarizes, and drafts.
- **Writing** — outlines, edits, and long-running document work that survives across sessions.
- **Home & ops** — runbooks, scripted chores, "check on X and tell me," scheduled tasks.

Because chats are persisted and resumable, you start something on your laptop and
pick it up on your phone hours later — the agent is still there, with all its
context.

## The real power is composition

Paddock is most useful when it runs on an **always-on machine** and you give its
agents the **tools they need to do real work**. On the author's own setup that
means a small, dedicated box that is on 24/7 and composes Paddock with:

- a **`gh` CLI authenticated with a scoped GitHub token** (so agents can open PRs —
  but only against what that box should touch),
- media tools like **`ffmpeg`**, plus whatever a given kind of work needs,
- a **process manager** so agents can spin up dev/preview servers you can open in a browser.

That composition — an isolated, always-on environment plus exactly the right tools —
is what turns Paddock from "a chat UI" into "a place where work actually gets done."

## Where to go next

- [Deploying Paddock](/guides/deploying/) — the recommended always-on setup.
- [Securing Paddock](/guides/securing/) — **read this** before anyone else can reach it.
- [A home-lab setup](/guides/home-lab/) — how the author runs Paddock in production.
