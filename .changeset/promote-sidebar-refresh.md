---
"@paddock/web": patch
---

Promoting a chat to a project now adds it to the sidebar immediately (#566)

The promote action always did the right thing server-side — the project was
created and the chat's transcript re-homed — but the client only navigated, so
the new project was missing from the left nav until you reloaded. The project
list has no push channel, so the handler now inserts the returned project into
the projects context, exactly as the New Project path already does.

Two further bugs in the promote dialog, both from one over-subscribed effect
that reset the form on almost any re-render rather than only on open:

- The project name you typed was silently reverted to the chat's name whenever
  the parent re-rendered — which, in a live chat view, is often.
- A failed promote could never show its error: the reset ran again as the submit
  left its busy state and wiped the message one render after it was set.
