# ADR 0001 — Load CesiumJS as an external UMD bundle, not through the app bundler

- Status: Accepted
- Date: 2026-08-31
- Milestone: M0

## Context

The web app is Next.js 16.3.3, which uses Turbopack by default. CesiumJS 1.144.0 is
the visualisation engine. The conventional CesiumJS/Next integration imports `cesium`
as an ES module and uses `copy-webpack-plugin` plus `DefinePlugin` to place static
assets and define `CESIUM_BASE_URL`.

Three problems, discovered in order:

1. **Turbopack does not support webpack plugins.** The conventional setup is simply
   unavailable.
2. **pnpm links packages through a virtual store**, so `node_modules/cesium` is a
   symlink into `node_modules/.pnpm/cesium@1.144.0/...`. Glob-based copy tools resolve
   this inconsistently across platforms.
3. **Turbopack cannot correctly minify Cesium 1.144.** This is the decisive one.
   Cesium inlines binary data (compressed WASM) as string literals. Turbopack's
   minifier rewrites some of these into *template* literals, where octal escape
   sequences are illegal. The emitted 4.5 MB chunk then fails to parse:

   ```
   SyntaxError: Octal escape sequences are not allowed in template strings.
   ```

   The failure is silent and severe: it is a parse error, so it carries no stack
   trace, the module never evaluates, and the globe hangs on its loading state
   forever. `next build` reports complete success, because the code compiles — it
   just cannot be parsed by a browser.

This was found only because the Milestone 0 verification loads the built app in a
real browser. A build-only gate would have passed it straight through.

## Decision

Do not let the application bundler process Cesium at all.

- `scripts/copy-cesium-assets.mjs` resolves the Cesium package with Node's own
  resolver (correct under pnpm, npm and yarn, on every platform) and copies the
  prebuilt `Cesium.js` UMD bundle plus `Workers`, `ThirdParty`, `Assets` and `Widgets`
  into `public/cesium`.
- `cesium-loader.ts` sets `window.CESIUM_BASE_URL`, then injects a `<script>` tag and
  resolves with `window.Cesium`.
- Types come from `import type * as CesiumNamespace from "cesium"`, which is erased at
  compile time, so full type safety is retained without the bundler seeing runtime code.
- `next.config.ts` contains no bundler configuration whatsoever.

## Consequences

**Good**

- The globe actually works. Verified in a real browser: live WebGL context, no console
  errors, no failed requests, Cesium attribution present.
- The largest app chunk dropped from **4.7 MB to 224 KB**.
- Faster builds; the browser caches ~6 MB of engine independently of app code.
- No Cesium Ion token required — offline Natural Earth imagery ships with Cesium, so
  the app runs with zero credentials. Ion stays optional for terrain and high-res imagery.

**Bad**

- Cesium loads as a second network request rather than as part of the app bundle.
  Mitigated by it being cacheable and by the shell rendering before the engine loads.
- No tree-shaking of Cesium. In practice the ESM build was not meaningfully
  tree-shaken either, and the UMD bundle is already minified.
- The copy script is a build step that must run before dev and build. It is wired into
  `predev` and `prebuild` so it cannot be forgotten.

## Alternatives rejected

- **Disable minification** — degrades the whole application to work around one dependency.
- **Force webpack instead of Turbopack** — abandons the framework default and its
  performance, to keep an integration we do not need.
- **Wait for a Turbopack fix** — unbounded, and the workaround is strictly better anyway.
