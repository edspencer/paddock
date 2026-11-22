---
"@paddock/server": minor
"@paddock/web": minor
---

When Claude Code needs permission for a tool use in a chat (an edit to a file under `~/.claude/`, say), the chat now shows the request above the composer with Allow once, Deny and, when the request names one exact file or command, Always allow, and the turn waits for your answer instead of the request being denied on the spot. Stopping the turn cancels any request still waiting. This works on the default `session` drive mode only; chats on `driveMode: batch` still deny such requests. Once settled, each request stays in the transcript as a line above the tool call it was about, saying whether it was allowed once, always allowed, denied or cancelled, both live and after a reload.
