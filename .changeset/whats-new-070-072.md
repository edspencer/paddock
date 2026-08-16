---
"@paddock/web": patch
---

Refresh Home's What's New card for 0.70 through 0.72. The list rotates to the
newest twelve — posture profiles, service control, Home as the front door,
stopping one background task, the linked-directory git surfaces, and the inline
code fix — and the six entries that fall off the bottom move to the website's
archive page, which is where the cap in `whats-new.test.ts` is designed to push
them. No behaviour change; the card, the pager and the cap are untouched.
