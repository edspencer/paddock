---
"@paddock/server": minor
"@paddock/web": minor
---

Retire "keeper" from the user-facing copy (#585). The UI now says **Claude** —
Paddock is a thin layer over Claude Code, so the persona was inventing a second
actor that does not exist.

| before | after |
|---|---|
| `Message the keeper agent…` | `Message Claude…` |
| `…stream live from the keeper agent` | `…stream live from Claude` |
| `No files yet. Files the keeper agent writes appear here.` | `No files yet. Files Claude writes appear here.` |
| `Runs appear here once the keeper starts finishing turns.` | `Runs appear here once Claude starts finishing turns.` |
| `consulting the keeper` (composer spinner) | `consulting Claude` |
| `The keeper will respond again after the quota resets.` | `Claude will respond again after the quota resets.` |
| Settings section `Keeper agent` | `Claude` |
| `How this project's keeper agent runs. Changes re-register the keeper.` | `How Claude runs in this workspace. Changes take effect on the next turn.` |
| `Keeper tools` (trigger capability badge) | `Claude's tools` |
| `Keeper default` (trigger model placeholder) | `Workspace default` |
| `runs as the keeper (full tools)` | `runs as Claude (full tools)` |

Where a sentence did not need an actor the word is simply gone rather than
substituted — "a dedicated keeper agent" drops out of the empty-projects copy,
"a single keeper run" becomes "a single run".

Server-authored strings the user reads follow the same rule: the turn-notice
messages (`Claude reached its turn limit…`, `Claude's turn failed…`), the
registered agent's description and system prompt, and the herdctl fleet
description.

Behaviour is unchanged. The `keeper-` agent-name prefix is untouched — it is a
persisted on-disk encoding, not a word the user sees.
