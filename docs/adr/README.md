# Architecture Decision Records

Each ADR records a decision that was expensive to reach, surprising, or would
otherwise be re-litigated later. Decisions backed by measurements quote the numbers
and name the benchmark that produced them.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-cesium-loading-strategy.md) | Load CesiumJS as an external UMD bundle, not through the app bundler | Accepted |
| [0002](0002-propagation-strategy.md) | WASM bulk propagation off the render thread, with interpolation | Accepted |
| [0003](0003-mobile-renderer.md) | Mobile 3D globe: bundled CesiumJS in a WebView, native UI around it | Accepted, device gate outstanding |
| [0004](0004-orbital-data-model.md) | OMM-first elements, catalog IDs as strings, branded units | Accepted |
| [0005](0005-provider-access-and-rate-policy.md) | Server-side provider access behind a persistent, leased fetch guard | Accepted |
| [0006](0006-mobile-web-performance.md) | How much of the catalog a phone browser draws | Accepted (iPhone 14, 60 fps at 16,655 objects) |

## Reproducing the benchmarks

```bash
pnpm --filter @orbitwatch/orbit-core bench   # SGP4/SDP4 propagation throughput
pnpm --filter @orbitwatch/contracts bench    # WebView bridge payload cost
pnpm --filter @orbitwatch/web exec playwright test e2e/renderer-bench.spec.ts
```

One benchmark is deliberately not in that list. `/bench/device` (ADR 0006) has to be
opened by hand on a real phone against a production build served on the LAN, because the
one number it exists to produce — sustained frame time with a GPU — is meaningless in
headless Chromium, where rasterisation falls back to SwiftShader.

Numbers in the ADRs were taken on the development machine (Node 24.16.0, win32/x64)
and are medians of repeated runs. They are used for relative comparisons between
strategies, which is what the decisions turn on; absolute values will differ on other
hardware, and mobile device figures are explicitly still outstanding (ADR 0003).
