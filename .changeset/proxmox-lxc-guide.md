---
"@paddock/server": patch
---

Docs: add a **Running Paddock on Proxmox (LXC)** guide — a bridge between the generic Deploying guide and the home-lab narrative. Covers creating an unprivileged Debian LXC (UI / `pct` / the `proxmox-iac/` Tofu module, incl. `nesting=1,keyctl=1` for Docker/devbox), then both deploy paths: **Path A** — `docker run` inside the LXC (`paddock-deploy/docker/`), and **Path B** — tarball + systemd via OpenTofu + Ansible (`paddock-deploy/proxmox-iac/`). Links the Securing guide and the `auth-basic/` Tier-1 sidecar, and explains the safe-by-default loopback bind + `PADDOCK_DANGEROUSLY_ALLOW_OPEN` for the container case.
