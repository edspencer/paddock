---
"@paddock/server": patch
---

Refactor: split the oversized `herdctl.ts` (~1660 lines) into focused sibling modules, leaving `HerdctlService` as the cohesive stateful seam. Extracts the pure name/visibility helpers + constants into `herdctl-agent-names.ts`, the four agent-config builders + `ensureConfigFile` into `herdctl-agent-config.ts` (pure functions taking `cfg`), and the on-disk `job-*.yaml` reads + adoption/attribution writes into `herdctl-jobs.ts`. `herdctl.ts` drops to ~975 lines; the public import surface is unchanged (all moved names are re-exported from `./herdctl.js`) and behavior is identical. Part of #403.
