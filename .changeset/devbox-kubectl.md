---
"@paddock/server": patch
---

devbox image: add `kubectl`. A keeper asked "is the deploy healthy?" needs one
binary to make a cluster legible — describe a pod, tail logs, check a rollout —
and no amount of credentials substitutes for the client being absent. Same shape
as the Docker CLI already in the image: the **client only**, with **no kubeconfig
and no cluster credentials** baked in; those are per-deployment and belong to the
operator. It also can't be added downstream, because `kubectl` is in none of the
apt sources the image carries, so a derived `apt-get install kubectl` fails
outright. Shipped as a pinned static binary (`KUBECTL_VERSION`, currently
`1.36.3`) with the per-arch SHA-256 pinned in the Dockerfile and verified at
build time, selected by `TARGETARCH` so the arm64 image gets an arm64 binary. No
new apt repository or trust root. Base is untouched; devbox grows ~60 MB on
~4.9 GB.
