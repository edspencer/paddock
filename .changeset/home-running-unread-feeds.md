---
"@paddock/server": patch
"@paddock/web": patch
---

Lead the Home tab with what needs you: running chats, then unread chats.

**The feeds.** Home used to open on a list of recent chats — the same list the
sidebar already shows in full, so the front door duplicated the furniture and
buried the signal. It now opens on the two states that actually want a decision:
chats with a **live turn**, then chats holding an **unread reply**. Everything
else (files, notes) follows.

Both feeds come from one new route, `GET <base>/chats/attention`, scoped to the
workspace's **subtree**. A workspace's key is its path relative to the projects
root, so its descendants are exactly the workspaces it prefixes — and the root's
key is `""`, which prefixes every key there is. The root's Home is therefore
fleet-wide (every project's live work plus its own) and a project's Home is
scoped to itself, through one handler and one component that never learn which
they are rendering. No `root` flag, no second implementation to drift. Nesting,
when it lands, gives an intermediate workspace the same behaviour for free.

`running` is read from the live session hub rather than inferred from
timestamps, so it cannot disagree with the streaming dots. A chat is never in
both lists — a live turn hasn't landed a reply yet, so running wins.

**Why this could not have worked before.** The client only ever opened its
WebSocket from `subscribe()`, so landing on Home with no chat pane mounted
opened *no socket at all* and the running set stayed permanently empty — and an
empty running set is indistinguishable from a quiet instance, which is why the
in-flight badge appeared merely unreliable rather than dead (#573). Watching the
active set is now itself a reason to hold a socket, and the server already
replays its whole running snapshot to every socket on connect, so the first
paint is correct.

**The Projects section is gone from Home.** It hosted the app's ONLY New Project
button, so that moved to the sidebar's Projects header — replacing the project
count, which answered a question nobody asks while the list sits directly
beneath it. Same `+` affordance as the chat sidebar's New chat, in the same
place relative to its list.

**Notes.** `OVERVIEW.md` now renders on Home beside `CHANGELOG.md`, both
collapsible with the choice remembered per workspace. It rides the workspace
payload next to `changelog`, so the two can never render a beat apart. The old
bottom "Overview" card (a summary plus a metadata table) is deleted — it
described the workspace rather than offering a way into it, and Settings already
owns editing that.
