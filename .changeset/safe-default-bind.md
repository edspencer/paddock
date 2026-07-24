---
"@paddock/server": minor
---

Safe-by-default binding (#435): the bind host now defaults to `127.0.0.1`
(loopback only) instead of `0.0.0.0`, so a fresh source/tarball run is
network-closed. A new bind-safety guard couples exposure to authentication —
binding a non-loopback host while `PADDOCK_AUTH_MODE=none` **refuses to start**
(mirroring the jwt-without-JWKS fail-closed check) unless
`PADDOCK_DANGEROUSLY_ALLOW_OPEN` is set, in which case it boots with a loud
warning. Binding non-loopback with a real auth mode (`trusted-header`/`jwt`)
needs no flag, and deployments that set `HOST`/`PADDOCK_HOST` explicitly are
unaffected — only the default changed. The container image keeps binding
`0.0.0.0` (the network namespace is its boundary); recipes carry the host-side
publish posture.
