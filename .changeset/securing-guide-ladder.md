---
"@paddock/server": patch
---

Docs: refresh the **Securing Paddock** guide into a four-tier ladder — Tier 0 network isolation (`none` + VPN), Tier 1 sidecar Basic Auth (`trusted-header`, recipe in `paddock-deploy/auth-basic/`), Tier 2 Cloudflare Access (`jwt`), Tier 3 Authentik/Authelia forward-auth (`jwt`) — all edge-based, no built-in password. Adds the Cloudflare Access `jwt` config and links the new Basic Auth sidecar recipe.
