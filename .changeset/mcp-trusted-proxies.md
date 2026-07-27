---
"@paddock/server": patch
---

Management API: only believe `X-Forwarded-Proto` from a trusted proxy (#474)

The `/mcp` plaintext guard refuses a bearer token over a plaintext non-loopback
connection. It honoured `X-Forwarded-Proto: https` from **any** peer, so the
guard could be switched off by the caller — including by the operator it exists
to protect, copy-pasting a header out of a smoke-test recipe onto a real network.

The forwarded scheme is now believed only when the immediate peer (the socket
address, which no client can set) is a trusted proxy. New
`managementApi.trustedProxies` / `PADDOCK_MANAGEMENT_TRUSTED_PROXIES`: IPs,
CIDRs, the presets `loopback` / `linklocal` / `uniquelocal`, or `none` / `all`.

The default — loopback plus the private address space — keeps every sidecar
deployment working, while a **public** peer can no longer switch the guard off.
Name your TLS terminator explicitly to turn the guard into a real control; the
server logs a one-per-peer warning while it is leaning on the default.

Not an authentication change: `/mcp` still requires a valid bearer token, and
spoofing the header never granted access.
