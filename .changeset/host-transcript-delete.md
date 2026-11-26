---
"@paddock/server": minor
"@paddock/web": minor
---

Under `claude.transcripts: host`, deleting a chat now actually deletes it: its transcript and sidecar folder are removed from `~/.claude/projects`, so the chat also leaves your Claude Code history instead of reappearing in the list on the next refresh. The delete confirmation says so before you confirm. Previously such a delete only released the chat and left the file on disk.
