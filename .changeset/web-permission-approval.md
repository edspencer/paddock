---
"@paddock/server": minor
"@paddock/web": minor
---

When Claude Code needs permission for a tool use in a chat (an edit to a file under `~/.claude/`, say), the chat now shows the request above the composer with Allow once, Always allow and Deny, and the turn waits for your answer instead of the request being denied on the spot. Stopping the turn cancels any request still waiting. This works on the default `session` drive mode only; chats on `driveMode: batch` still deny such requests.
