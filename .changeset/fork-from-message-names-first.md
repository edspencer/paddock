---
"@paddock/web": patch
---

Forking from a message now asks for a name first, like every other fork does.

The transcript's per-message **Fork a new chat from here** used to fire the
moment you clicked it, titling the result `Fork of <chat>` and navigating away —
while the sidebar's fork button opened a dialog and let you name the branch. That
asymmetry was backwards: forking from a *specific* message is the more deliberate
of the two, and the name is where the reason for the split gets recorded. Both
paths now open the same **Fork name** dialog, pre-filled and selected so a
keystroke replaces the default, and Cancel or Escape backs out having forked
nothing.

The branch point still comes along: the message's uuid is carried through the
dialog, so the fork stops at the message you picked rather than copying the whole
transcript. The single-flight guard that stops a double-click minting two forks
now covers both paths.
