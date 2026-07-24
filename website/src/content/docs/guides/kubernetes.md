---
title: Running Paddock on Kubernetes
description: Run Paddock on a cluster with the published images — one replica, one persistent volume, auth at the edge. A ready-made Kustomize recipe, explained.
---

Paddock runs happily on a single Docker host (see [Deploying Paddock](/guides/deploying/)),
and that's the right home for most people. But if you already operate a cluster —
a home-lab k3s node, or a shared team cluster — you may prefer to run Paddock the
same way you run everything else. The [`kubernetes/`
recipe](https://github.com/edspencer/paddock-deploy/tree/main/kubernetes) in
`paddock-deploy` is a set of plain manifests, assembled with
[Kustomize](https://kustomize.io/) (built into `kubectl`) — **no Helm required.**

:::caution[Paddock is an app, not a scalable service]
Paddock is **single-writer**: one process owns one data volume. This recipe runs
**one** replica against **one** persistent volume. Read
[Statefulness & single-writer](#statefulness--single-writer) before you touch
`replicas` — scaling up will corrupt your data, not spread the load.
:::

## When Kubernetes makes sense

Reach for the cluster when you already have one. Kubernetes buys you a lot of
operational machinery — scheduling, rollouts, health-checked restarts, an ingress
story — but Paddock is a stateful, single-process app that doesn't *need* most of
it. So:

- **Use it if** you run a cluster already and want Paddock managed by the same
  tooling, secrets, and ingress as your other apps — or you want health-checked
  auto-restart and declarative, version-controlled deploys for free.
- **Skip it if** you just want Paddock running on a box. A single `docker run` or
  a Compose file on an always-on host ([Deploying Paddock](/guides/deploying/)) is
  simpler, and you lose nothing — Paddock can't scale horizontally anyway.

## What's in the recipe

The manifests live under
[`paddock-deploy/kubernetes/`](https://github.com/edspencer/paddock-deploy/tree/main/kubernetes)
and are wired together by `kustomization.yaml`:

| File | Purpose |
| --- | --- |
| `kustomization.yaml` | Assembles the resources and pins the image tag. |
| `deployment.yaml` | The Paddock pod — `replicas: 1`, `strategy: Recreate`, `/api/health` probes. |
| `service.yaml` | Internal `ClusterIP` on port 80 → container port 4000. |
| `pvc.yaml` | `ReadWriteOnce` claim mounted at `/data` — the stateful bit. |
| `secret.example.yaml` | Template for the Claude / GitHub token Secret. |
| `ingress.yaml` | Optional external route — only safe behind an auth layer. |

## Quick start

You need a cluster with a `kubectl` context pointing at it, and a **default
StorageClass** (or edit `storageClassName` in `pvc.yaml`).

```sh
# 1. A namespace to hold the instance.
kubectl create namespace paddock

# 2. The token Secret — create it imperatively so tokens never touch a file.
kubectl -n paddock create secret generic paddock-secrets \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN='sk-...' \
  --from-literal=GITHUB_TOKEN='ghp-...'        # optional, enables git push

# 3. Deploy.
kubectl -n paddock apply -k .

# 4. Watch it come up (readiness probes /api/health).
kubectl -n paddock rollout status deploy/paddock
```

Before you've wired up an Ingress, reach it by port-forwarding:

```sh
kubectl -n paddock port-forward deploy/paddock 4000:4000
curl -fsS http://127.0.0.1:4000/api/health      # -> {"ok":true}
```

## Statefulness & single-writer

**`/data` is the instance.** It holds the project store, the generated herdctl
config and state, and — because the image sets `HOME=/data` — the Claude session
transcripts under `~/.claude/projects`. **Resume depends on this volume
persisting.** Lose it and you lose every project and conversation, so the PVC must
be durable and must survive pod restarts.

Paddock is **single-writer**: exactly one process may own `/data` at a time. The
recipe enforces that three ways, and you must keep all three:

- **`replicas: 1`.** Don't scale up. To run more Paddocks, deploy separate
  instances with **separate** volumes and namespaces — never two pods on one PVC.
- **`strategy: Recreate`** (not `RollingUpdate`). The old pod fully terminates and
  releases the volume before the new one starts, so a rollout never briefly runs
  two writers. With a `ReadWriteOnce` volume, `RollingUpdate` would also deadlock —
  the new pod can't attach a volume the old one still holds.
- **`ReadWriteOnce` PVC.** A single node mounts it; on a multi-node cluster the pod
  is scheduled to the node holding the volume.

The recipe doesn't back anything up. Snapshot the volume (or schedule a copy of
`/data`) so you can recover it.

## Secrets: the Claude (and GitHub) token

Paddock needs a Claude credential to run keepers, delivered via a `Secret` that
the Deployment reads with `envFrom`:

- **`CLAUDE_CODE_OAUTH_TOKEN`** — a Claude Max token for the `cli` runtime — **or**
  **`ANTHROPIC_API_KEY`** for the `sdk` runtime (API pricing). Provide one.
- **`GITHUB_TOKEN`** *(optional)* — enables keepers to `git push` to backing repos.
  Scope it to just the repos this instance should touch.

Create the Secret imperatively (as in the quick start) so tokens never land in a
file, or copy `secret.example.yaml` → `secret.yaml`, fill it in, and add it to
`kustomization.yaml`. **Never commit real tokens.** The Secret reference is marked
`optional: true`, so the pod still boots (and `/api/health` passes) without it — a
valid token is only needed once a keeper actually runs a turn.

## Base vs. devbox image

The Deployment uses the **base** image, `ghcr.io/edspencer/paddock:latest` — the
app plus the `git` / `gh` / `claude` CLIs. That's enough for keepers that write
code and open PRs.

For the full coding-agent toolbox — `pm` preview servers, `ffmpeg`, a headless
Playwright browser, the Docker CLI — switch to the **devbox** image by editing the
tag in `kustomization.yaml`:

```yaml
images:
  - name: ghcr.io/edspencer/paddock
    newTag: devbox        # was: latest
```

The devbox image is much heavier (the Chromium layer alone is ~1 GB) and wants more
memory — raise the container `resources.limits` in `deployment.yaml`. In
production, pin a released version tag (e.g. `:v0.43.0` / `:v0.43.0-devbox`) rather
than the moving `:latest` / `:devbox`.

## Ingress & auth at the edge

**Paddock has no built-in authentication.** Inside a cluster the pod is reachable
from anything that can route to its Service, so never expose it without an auth
layer in front:

- Keep `service.yaml` as `ClusterIP` (the default). Don't turn it into a bare
  `LoadBalancer` / `NodePort`.
- Put an authenticating proxy in front. `ingress.yaml` ships the ingress-nginx
  external-auth annotation pattern as a starting point — point it at an external
  auth proxy (oauth2-proxy, Authelia, Authentik, Cloudflare Access) or your
  controller's auth middleware, then edit the host, TLS secret, `ingressClassName`,
  and auth URLs and add it to `kustomization.yaml`.
- Alternatively, run Paddock in one of its downstream auth modes (`trusted-header` /
  `jwt`) so it turns an already-authenticated upstream identity into a user. Set
  `PADDOCK_AUTH_MODE` and friends via env in `deployment.yaml` (commented examples
  are there). Health probes are always exempt from auth.

The tiers, and the trade-offs between them, are covered in full in
[Securing Paddock](/guides/securing/) — read it before you expose an instance.

:::note[WebSockets]
Paddock uses WebSockets for live chat. Most ingress controllers proxy them on the
same route with no extra config; if yours closes idle upgrades early, raise the
proxy read/send timeouts (the nginx annotations are in `ingress.yaml`).
:::

## The recipe

The manifests, a `kubectl`-verified quick start, private-registry pull secrets, and
a cleanup teardown all live in the recipe. Start there and adapt it to your
cluster:

**→ [`paddock-deploy/kubernetes/`](https://github.com/edspencer/paddock-deploy/tree/main/kubernetes)**
