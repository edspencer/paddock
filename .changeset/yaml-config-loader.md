---
"@paddock/server": minor
---

Config: YAML instance-config file loader, precedence file < env (#270).

Ticket F2 of the Events / Schedules / Config initiative, building on F1 (#269).
`PaddockConfig` is already a single serializable object; it can now be populated
from an optional **YAML instance-config file** with **environment variables
overriding** file values (precedence **file < env**). Existing `PADDOCK_*`
deployments are unaffected — with no file present, resolution is byte-for-byte
the env-only behaviour it was before.

- **Location.** `PADDOCK_CONFIG` (an explicit path) if set, otherwise
  `<PADDOCK_DATA_DIR>/paddock.config.yaml`.
- **Precedence.** Every file value is threaded in as the *fallback* beneath the
  matching env read (via the existing `envOr`/`envOpt` helpers), so an env var
  always wins over the file, and the hardcoded default still applies when neither
  provides a value. Booleans/enums/paths keep their exact parsing and
  fall-back-to-default semantics. `PADDOCK_BROWSER_MCP` keeps its literal-`1`
  env semantics; the file layer uses the shared `1`/`true`/`yes` convention.
- **No-op when absent.** A missing default file yields env-only behaviour. An
  explicit `PADDOCK_CONFIG` pointing at a *missing* file, or a present-but-
  malformed file (unparseable YAML, or a top-level list/scalar instead of a
  mapping), fails startup with a **clear error** instead of a half-empty config.
- Uses the same `yaml` library the repo already uses for `project.yaml`;
  `PaddockConfig` stays a plain serializable object. This is the container the
  schedule (and later hook) declarations will live in.

Documented in `docs/CONFIGURATION.md`.
