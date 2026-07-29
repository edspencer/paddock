---
"@paddock/web": patch
---

Replace the last three native browser dialogs with Paddock's own modals (#541).
Renaming a chat popped a `window.prompt()`, and reverting a chat / deleting a
trigger popped `window.confirm()` — grey, unthemed browser chrome sitting one
button away from Fork Chat's styled dialog, prefixed with `"<host> says"` in the
installed PWA, and blocking the main thread (including the live transcript)
until dismissed.

The revert dialog is the one that gains more than polish. Its warning — that
tool calls after the revert point are **not** undone, only the conversation is —
was being assembled into a single `\n\n`-delimited string, so the most important
sentence in the most destructive of the three actions arrived as undifferentiated
plain text. It is now structured content: the message and tool-call counts are
emphasised, and the "those actions are not undone" caveat is its own callout
instead of a clause buried mid-paragraph.

Two behaviours are deliberately preserved rather than reimplemented. Clearing
the rename field still **resets** a chat to its generated preview name — that was
`prompt()`'s `""`-vs-`null` return doing double duty, and a dialog that only
reported "closed" vs "submitted" would have quietly dropped it; the modal now
advertises it (the hint names the fallback and the button relabels to "Reset
name"), where the prompt could only be discovered by accident. And the revert
dialog opts out of backdrop-click dismissal, since it carries warning text meant
to be read and silently discarding that decision on a stray click is worse than
requiring a button.

Also: `ConfirmDialog` gains `wide` and `dismissOnBackdrop`, the Escape-to-close
listener the modals each had their own copy of is now one `useEscapeKey` hook,
and the two re-thrown failures (revert, trigger delete) now surface inside the
dialog and leave it open to retry rather than closing onto a banner elsewhere.
A source-scanning test keeps the ban enforced rather than documented.
