---
"@paddock/server": patch
---

Remove the dead `devServers` / `PADDOCK_DEV_SERVERS_ENABLED` config. It was loaded and unit-tested but nothing consumed it — it used to gate the system-prompt style before #176 decoupled that into `PADDOCK_KEEPER_NATIVE_PROMPT`. The `PADDOCK_DEV_SERVERS_ENABLED` / `PADDOCK_DEV_SERVERS_DOMAIN` env vars, the `devServers` config block, and the associated instance-config field are gone. The preview-server (`pm`) capability is provided by the devbox image and advertised via an instance-wide `CLAUDE.md`, not a Paddock flag.
