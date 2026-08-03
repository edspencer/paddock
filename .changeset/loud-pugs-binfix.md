---
"@paddock/server": patch
---

Fix `npx @edspencer/paddock` doing nothing at all

**0.57.0, 0.58.0 and 0.59.0 shipped a CLI that printed nothing and exited 0.**
Any invocation through npm — `npx @edspencer/paddock`, or a global install —
was a silent no-op. Running the file directly with `node` worked, which is why
it escaped notice.

The cause was the run-directly guard introduced in #638 so that unit tests could
import the entrypoint without executing it:

```ts
if (pathToFileURL(process.argv[1]).href === import.meta.url) main();
```

npm installs a `bin` as a **symlink** at `node_modules/.bin/paddock`, so
`process.argv[1]` is the link path while `import.meta.url` is the module's
realpath. The two never match, so `main()` never ran.

`realpathSync(argv[1])` would have fixed that one instance. Instead the pure
parts (`parseArgs`, `nodeVersionProblem`, `explainListenError`, `USAGE`) move to
`cli/args.ts`, which is importable without side effects, and `paddock.ts` now
**always** runs. There is no condition left to get wrong on the next shim,
platform or package manager.

Guarded by a new integration test that spawns the entrypoint **through a
symlink** — the invocation shape every earlier check missed. Verified to fail
against the old code and pass against the new.
