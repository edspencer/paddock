---
"@paddock/server": patch
"@paddock/web": patch
---

Fix the project **Settings** page crashing for any project whose `project.yaml`
declares `links` as a bare YAML string list (the natural shorthand,
`- https://example.com`) rather than the `{label, url}` object form. Such entries
reached the DTO as raw strings, and the Settings pane's `cleanedLinks` memo called
`l.url.trim()` on them, throwing a `TypeError` during render (which also prevented
the Schedules section from ever loading). `ProjectStore.normalize` now coerces
`links` at the read boundary via a new `normalizeLinks` helper — a bare string
becomes `{label: "", url: <string>}`, object links are trimmed and kept, and
url-less / malformed entries are dropped. Because normalization runs on read, the
next save round-trips the file into object form, so an affected project self-heals.
