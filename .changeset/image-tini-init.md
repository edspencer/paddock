---
"@paddock/server": patch
---

Image: run `tini` as pid 1 so orphaned processes get reaped. Without an init the
Paddock server itself is pid 1, and a server never calls `wait()` — so every
orphan that exits *correctly* stays in the process table as a zombie forever.
Chromium is the worst offender because it behaves well: it watches its pipe,
self-exits when its parent dies, and the corpse then has nobody to reap it.
`npm run demo:gif` alone left ~4 chrome zombies per run and 1 esbuild per build,
on clean exits; one dev box reached ~1,650. Zombies hold no memory, but they
consume pid-table entries and make every process census lie — a count of
`chrome-headless` cannot tell a live 100 MB browser from a 0 MB corpse.
Measured in the real image: 60 orphaned processes left 60 permanent zombies
before, and 0 after. Baked into the image rather than left to `docker run
--init`, because `--init` is a Docker runtime flag with no Kubernetes
equivalent and Paddock also runs on k3s; `--init` stays harmless if passed
anyway. Signal behaviour is unchanged — `docker-entrypoint.sh` `exec`s the
server, so tini's immediate child *is* the node process and the server's own
SIGTERM handler still runs: `docker stop` took 0.19s and exited 0 both before
and after, with identical shutdown logs. Applies to both the base and devbox
images (devbox inherits the entrypoint), and adds no measurable size.
