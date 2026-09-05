/**
 * Stand-in for satellite.js's WebAssembly SGP4 runtime on React Native.
 *
 * satellite.js reaches its WASM build through `await import('#wasm-single-thread')`.
 * Metro follows dynamic imports when bundling, so the Emscripten glue is pulled into
 * the app bundle even though nothing here calls it — and that glue uses top-level
 * `await` and `import.meta.url`, neither of which Hermes can parse. The bundle fails
 * before the app exists.
 *
 * Stubbing it is correct rather than merely convenient. The WASM path exists for
 * whole-catalog bulk propagation in the web worker; the native app propagates the
 * selected object, one satrec at a time, where the cost of crossing into WASM exceeds
 * the gain. React Native has no WASM runtime to load it into in any case.
 *
 * It throws rather than returning a no-op. If a future code path does ask for the WASM
 * propagator on a device, the failure must name its own cause — a silent fallback
 * would be a different propagator producing different numbers, which is precisely
 * what the M6 cross-platform agreement tests exist to catch.
 */
export default function createWasmModuleUnavailable(): never {
  throw new Error(
    "satellite.js WebAssembly propagation is not available on React Native. " +
      "Native builds use the JavaScript SGP4 implementation; see " +
      "apps/mobile/src/lib/wasm-unavailable.ts.",
  );
}
