# Dependency patches

## `satellite.js@7.1.0` — exclude the Emscripten WASM glue from browser bundles

Adds a `browser` field mapping satellite.js's two Emscripten bundles to `false`, so
bundlers targeting a browser replace them with an empty module.

### Why

satellite.js's entry point ends with `export * from './wasm/index.js'`, which reaches
`dist/wasm/runtimes/index.js` and its dynamic imports of `#wasm-single-thread` and
`#wasm-multi-thread`. Those resolve to Emscripten `-sSINGLE_FILE` builds that are not
ordinarily bundleable:

- They embed the compiled WASM binary in the source. Both files contain thousands of
  NUL bytes (17,708 and 25,614) — `grep` classifies them as binary.
- Built without `-sENVIRONMENT`, they keep Emscripten's dual web/node glue, which calls
  `require("node:fs" | "node:path" | "node:url")` and dynamically imports `node:module`
  and `node:worker_threads`. None of those resolve in a browser bundle.

Pulling them into `apps/web` made `next build` hang indefinitely at "Creating an
optimized production build" — no error, no progress, flat memory. A Turbopack trace
(`NEXT_TURBOPACK_TRACING=1`) confirmed both files were in the module graph. This is the
upstream issue emscripten-core/emscripten#26134, which names Next.js Turbopack
specifically.

### Why a patch rather than config

Turbopack's `resolveAlias` cannot intercept these: `#wasm-single-thread` is a
package-internal `imports` specifier, resolved by the package resolver before user
aliases apply. This was verified — aliasing it changed nothing, and the trace still
showed both files in the graph. The `browser` field is the standard mechanism for
"this file is not usable in a browser bundle", and it applies wherever the package is
resolved rather than in one app's config.

### What this does not change

`@orbitwatch/orbit-core` calls only satellite.js's pure-JavaScript surface —
`twoline2satrec`, `json2satrec`, `sgp4`, `propagate`, `gstime`, `invjday`, `jday`,
`sunPos`, `shadowFraction`, `dopplerFactor`, `SatRecError` and the transforms. It uses
no WASM export. Browser propagation is unchanged and remains real SGP4/SDP4.

The `browser` field is scoped to browser bundles only, so Node consumers (`apps/worker`,
`apps/api`, Vitest) still resolve the real WASM runtimes. The WASM `BulkPropagator`
therefore remains available server-side and for any future opt-in use.

### On upgrade

Re-create the patch against the new version, and re-check whether upstream has shipped a
browser-only Emscripten build (`-sENVIRONMENT=web`), which would make this unnecessary.
