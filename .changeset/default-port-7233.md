---
"@paddock/server": minor
---

The default listen port moves from **4000** to **7233**.

4000 was a bad default. It is one of the most contested ports in local
development — Jekyll has defaulted to it since 2008, Phoenix defaults to it, and
it is a common pick for a hand-rolled Node server. The CLI has carried a comment
calling `EADDRINUSE` on 4000 "the likeliest first-run failure" for as long as the
error message has existed, which is a fair description of a default that makes
the first run fail.

7233 is `PADD` on a phone keypad (P=7, A=2, D=3, D=3). It is **not** registered
with IANA — checked against the published registry — and carries no malware
association.

**It is not unoccupied.** 7233 is the default frontend gRPC port for
[Temporal](https://docs.temporal.io/temporal-service/temporal-server), whose
7233/7234/7235/7239 block covers its frontend, history, matching and worker
services. That collision is real and worth naming, because Temporal's audience —
self-hosting developers running orchestration — overlaps ours more than the base
rate would suggest. It is still the better trade: Temporal is one specific
server, almost always run under Compose or k8s where the published port is
trivially remapped, whereas 4000 collides with a whole class of everyday tooling.
The failure mode is also loud rather than silent — `EADDRINUSE` at boot, with the
existing message naming the port and the flag that fixes it.

**Upgrading:** if you set `PORT`, `port:` in `paddock.config.yaml`, or `--port`,
nothing changes. If you relied on the default, the instance moves to 7233 and
anything in front of it — a reverse proxy `reverse_proxy paddock:4000`, a Docker
`-p 127.0.0.1:4000:4000` publish, a k8s Service `targetPort`, an SSH tunnel —
needs the new number, or pin the old one with `PORT=4000`.
