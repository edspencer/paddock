---
"@paddock/server": patch
---

Fix keeper-chat recovery (#301/#347): a background task killed at the turn boundary was undetectable because its `<task-notification>` is delivered to the SDK's input queue as a `queue-operation` entry, not a `type:"user"` transcript entry — the shape the recovery watch classified. The engine now recognises the queue-operation form (the only one present inside the watch window), so auto re-drive fires when enabled. The watch is also armed under `surfaceKilledTask` (default on) and, on detection, broadcasts a live `chat:killed_task` frame so the "keeper is idle / Continue" affordance appears without a manual refresh.
