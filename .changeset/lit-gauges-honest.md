---
"@paddock/web": patch
---

fix(web): an unmeasured setting and a measured zero now say so

Two places where the UI showed a value it did not have.

**The fleet readout's context gauge lit a segment at 0% (#819).** A
`Math.max(1, …)` floor meant a chat reporting `contextTokens: 0` drew 1/6 lit
while its own tooltip read "Context 0% full". The floor was guarding against a
rendered-but-empty gauge, but the component already omits the gauge entirely
when context is *unmeasured* — so the only case it could still reach was a
genuine zero, which is exactly the one worth drawing empty.

**A `string-list` setting with no override rendered as an empty box (#756).**
Capabilities → Offered models showed nothing while all five catalog models were
being offered, because `null` collapsed to `""` with no placeholder — so "unset"
and "explicitly emptied" were indistinguishable and neither said what was in
force. It now gets the same treatment its `text` sibling has: the default is
shown, captioned "Using the built-in default.", with a Restore default link.

That link is load-bearing rather than a nicety: the field's `onChange` filters
empty strings, so clearing the box yields `[]` and never `null`. Without it,
"no override" was unreachable from the UI the moment the field was touched.
