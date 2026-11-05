// A local npm registry, just enough of one for `paddock update` (CLI contract SPEC §5 step 3).
//
// It serves ONE package from tarballs on disk and forwards everything else to the real registry,
// which is what makes `npm install -g <our package>` work: our package resolves locally, and its
// hundred dependencies resolve upstream exactly as they always do.
//
// Three routes answer locally, for the package named in the state file:
//
//   GET /-/package/<name>/dist-tags   the dist-tags            (SPEC §5 step 3)
//   GET /<name>                       the packument            (npm install / npm cache add)
//   GET /<name>/<version>             one version's manifest   (SPEC §5 step 3, `engines`)
//   GET /_tarball/<version>           the tarball itself
//
// Everything else is a 302 to https://registry.npmjs.org. A scoped name arrives either as
// `@scope%2fname` or as `@scope/name` depending on the client, so both are accepted — `update`
// writes `%2f` (SPEC §5 step 3) and npm writes the slash.
//
// ## Why it is a separate process
//
// Because the test that drives it blocks. A caller using `execFileSync`/`spawnSync` to run the CLI
// cannot also answer HTTP from the same process: the kernel accepts the connection into the
// backlog and Node never reaches it, so the fetch times out, the CLI reads the timeout as "nothing
// there", and the test passes for the wrong reason. Wave C1 lost two CI runs to exactly that.
//
// ## How the parent changes the answers
//
// It rewrites the state file; this re-reads it on EVERY request. So `latest` can move between
// scenarios without a restart, and the parent needs no control channel.
//
//   node scripts/fake-registry.mjs <state.json> [port]
//
// State: { "name": "@edspencer/paddock", "distTags": { "latest": "0.2.0" },
//          "versions": { "0.1.0": { "tarball": "/abs/path.tgz", "manifest": { … } } } }
//
// It prints `fake-registry: listening <url>` on stdout once it is up, which is the line a parent
// waits for. CI and local only: it has no auth and serves whatever the state file points at.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";

const [stateFile, wantedPort] = process.argv.slice(2);
if (stateFile === undefined) {
  console.error("usage: fake-registry.mjs <state.json> [port]");
  process.exit(2);
}

const UPSTREAM = process.env.FAKE_REGISTRY_UPSTREAM ?? "https://registry.npmjs.org";

const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));

/**
 * Warn about a manifest that would install a package npm reports as installed and which does not
 * work (once per version, on stderr).
 *
 * This cost a CI round-trip. A hand-written `{ engines: { node: ">=22" } }` is a valid manifest,
 * so npm installs the tarball's files, writes NO `bin` shim, resolves NO dependencies, and exits
 * **0**. The symptom is the service dying on `Cannot find package 'fastify'` and the update
 * rolling back — a rig fault wearing a product failure's clothes. The manifest a fake registry
 * serves has to be the package's real `package.json`.
 */
const warned = new Set();
function warnAboutManifest(version, manifest) {
  if (warned.has(version)) return;
  warned.add(version);
  const missing = ["bin", "dependencies"].filter((k) => manifest[k] === undefined);
  if (missing.length === 0) return;
  process.stderr.write(
    `fake-registry: the manifest for ${version} has no ${missing.join(" and no ")}. ` +
      "npm will install it, exit 0, and produce something that does not run. " +
      "Serve the package's real package.json.\n",
  );
}

/** `@scope%2fname` and `@scope/name` are the same package. */
const decodeName = (s) => decodeURIComponent(s).replace(/%2f/gi, "/");

/**
 * The `dist` block npm verifies before it unpacks.
 *
 * Both hashes, because npm has used both: `integrity` (sha512, subresource form) is what modern
 * npm checks and `shasum` is what older clients and some caches still read. Computed per request
 * rather than once, so a parent that rewrites a tarball between scenarios cannot serve a stale
 * digest — which would fail as EINTEGRITY and read as a broken update rather than a broken rig.
 */
function distFor(url, tarballPath) {
  const bytes = fs.readFileSync(tarballPath);
  return {
    tarball: url,
    shasum: crypto.createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
  };
}

const server = http.createServer((req, res) => {
  let state;
  try {
    state = readState();
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`fake-registry: cannot read ${stateFile}: ${String(err)}`);
    return;
  }

  const base = `http://127.0.0.1:${server.address().port}`;
  const url = new URL(req.url, base);
  const path = url.pathname;
  const send = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const manifestFor = (version) => {
    const entry = state.versions[version];
    if (entry === undefined) return undefined;
    warnAboutManifest(version, entry.manifest ?? {});
    return {
      ...entry.manifest,
      name: state.name,
      version,
      dist: distFor(`${base}/_tarball/${encodeURIComponent(version)}`, entry.tarball),
    };
  };

  // The tarball.
  const tar = /^\/_tarball\/(.+)$/.exec(path);
  if (tar !== null) {
    const entry = state.versions[decodeURIComponent(tar[1])];
    if (entry === undefined) {
      res.writeHead(404).end("no such version");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    fs.createReadStream(entry.tarball).pipe(res);
    return;
  }

  // The dist-tags route (SPEC §5 step 3).
  const tags = /^\/-\/package\/(.+)\/dist-tags$/.exec(path);
  if (tags !== null) {
    if (decodeName(tags[1]) !== state.name) return proxy(req, res);
    send(state.distTags);
    return;
  }

  // The packument, and one version's manifest.
  //
  // Split into segments rather than matched with one regex: a scoped name arrives as EITHER one
  // segment (`@scope%2fname`) or two (`@scope/name`), and a pattern that allowed both let the
  // greedy name group swallow the version — so `/@scope%2fname/1.0.0` read as a packument request
  // for a package called "@scope%2fname/1.0.0", fell through to the proxy, and the CLI reported a
  // 404 from the real registry as "no such version".
  const pkg = packageRequest(path);
  if (pkg !== undefined && decodeName(pkg.name) === state.name) {
    if (pkg.version !== undefined) {
      const manifest = manifestFor(decodeURIComponent(pkg.version));
      if (manifest === undefined) {
        res.writeHead(404).end("no such version");
        return;
      }
      send(manifest);
      return;
    }
    const versions = {};
    for (const v of Object.keys(state.versions)) versions[v] = manifestFor(v);
    send({ name: state.name, "dist-tags": state.distTags, versions });
    return;
  }

  proxy(req, res);
});

/** `/<name>` or `/<name>/<version>`, for both spellings of a scoped name. */
function packageRequest(pathname) {
  const segs = pathname.slice(1).split("/").filter((s) => s !== "");
  if (segs.length === 0) return undefined;
  if (segs[0].startsWith("@")) {
    // One segment when the slash was escaped, two when it was not.
    if (/%2[fF]/.test(segs[0])) {
      return segs.length <= 2 ? { name: segs[0], version: segs[1] } : undefined;
    }
    return segs.length === 2 || segs.length === 3
      ? { name: `${segs[0]}/${segs[1]}`, version: segs[2] }
      : undefined;
  }
  return segs.length <= 2 ? { name: segs[0], version: segs[1] } : undefined;
}

/**
 * Everything that is not our package goes upstream, by redirect.
 *
 * A redirect rather than a streamed proxy because npm follows them, and because the tarball URLs
 * inside an upstream packument already point at the upstream host — so a dependency install never
 * comes back through here at all. One less thing to get wrong.
 */
function proxy(req, res) {
  res.writeHead(302, { location: `${UPSTREAM}${req.url}` });
  res.end();
}

server.listen(Number(wantedPort ?? 0), "127.0.0.1", () => {
  console.log(`fake-registry: listening http://127.0.0.1:${server.address().port}`);
});
