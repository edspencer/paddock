---
"@paddock/server": patch
---

Deleting a chat no longer destroys a transcript Paddock does not own (#689).

With the Claude home pointed at the user's own `~/.claude`, `DELETE /chats/:id`
returned `{"ok":true,"removed":true}` and unlinked the user's terminal `claude`
history for that directory. There is no copy to fall back on — Paddock plants no
symlink in a home it does not own (#682), so the file the agent reads and writes
*is* the user's. It is #682 pointed the other way: that one claimed where future
sessions get written, this one deleted the past ones.

Delete now releases the session in that case instead of removing it, and the
response carries `retained: true`. In a home Paddock owns the behaviour is
unchanged — the transcript is Paddock's own copy in the project's `.chats/`, and
delete still means delete.

Known gap, tracked in #689: a released chat is still listed, because a chat
Paddock created is rediscovered by scanning the home. Closing that needs a
tombstone, which is deferred to the `transcripts` mode work in #691 rather than
built against a flag that design removes.
