---
"@paddock/web": patch
---

docs(website): wire the new deploy guides into the sidebar and thread the images +
`paddock-deploy` recipes through the existing docs.

- Add **The Dev Box flavor**, **Running Paddock on Proxmox (LXC)**, and **Running
  Paddock on Kubernetes** to the Guides sidebar group.
- **Getting started** now explains the `:latest` (base) vs `:devbox` image tags.
- **Deploying Paddock** points at the `edspencer/paddock-deploy` recipes (`docker/`,
  `proxmox-iac/`, `kubernetes/`, `auth-basic/`).
- **A home-lab setup** notes the devbox image as the modern, pre-composed path and
  cross-links `paddock-deploy`, keeping the as-code narrative intact.
