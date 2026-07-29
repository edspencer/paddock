---
"@paddock/server": patch
"@paddock/web": patch
---

Drop four back-compat shims that no longer have anything to be compatible with
(#553). Two of them change the wire.

The project DTO no longer carries `created`. It was a dual-emit alias of
`started` — populated with the identical value, stripped again on write, and
documented as a reconciliation between two old specs. Its one consumer rendered
it as a read-only row *next to* `started`, so the project Settings tab showed
**"Started" and "Created" as two adjacent rows containing the same date**. That
duplicated row is gone; `started` remains, unchanged, as the creation date.

`GET /api/models` no longer returns `sweeperDefault`. Nothing read it — the
sweeper's model is resolved server-side and was never selectable in the UI, so
the field only ever described a decision the client couldn't influence.

The two internal shims: the `SWEEPER_MODEL` alias of `SWEEPER_DEFAULT_MODEL` is
gone (the one importer now uses the canonical constant), and the five instance
defaults on `getModels()` — `keeperDriveModeDefault`, `maxSpawnDepthDefault`,
`recoveryDefault`, `attachmentsDefault`, `curationDefault` — are now **required**
rather than optional "for back-compat with older servers". There is no older
server; the server sends all five unconditionally. The `??`/`if` guards that
existed to tolerate their absence are gone with them, which also means a fixture
can no longer omit one and silently exercise a shape the server never sends.
