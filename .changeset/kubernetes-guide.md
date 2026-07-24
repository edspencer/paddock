---
"@paddock/server": patch
---

Docs: add a **Running Paddock on Kubernetes** guide (#415). Covers when a cluster makes sense, the Kustomize manifest layout, the `/data` PVC and single-writer statefulness (`replicas: 1` + `Recreate` + `ReadWriteOnce`, on which resume depends), the Claude/GitHub token Secret, base vs. `:devbox` image, and ingress with auth at the edge. Links the `kubernetes/` recipe in `paddock-deploy` and the Securing Paddock guide.
