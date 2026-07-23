---
"@paddock/web": patch
---

Fix the Paddock MCP tool badge showing the wrong project. The brand badge on a `paddock_manage` tool card (e.g. `create_chat`) was a hardcoded "Paddock" label that CSS-uppercased to "PADDOCK", so a cross-project action — a keeper in project A creating a chat in project B — mislabelled the badge with the brand name instead of the target project, contradicting the card body's own "in {project}" line and open-chat link. The badge now reads the tool result's target `project` when the action carries one (create/fork/read/send/list-in-another-project), falling back to the "Paddock" brand label for project-less actions (`list_projects`, `fork_chat_batch`). Badge and body now agree.
