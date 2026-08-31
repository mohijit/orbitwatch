import type * as CesiumNamespace from "cesium";

/**
 * CesiumJS bootstrap for Next.js 16 / Turbopack.
 *
 * Cesium is loaded as a prebuilt UMD bundle via a <script> tag, NOT imported through
 * the application bundler. Three separate constraints force this, and the third is
 * the decisive one.
 *
 * 1. NO WEBPACK PLUGINS. Next.js 16 uses Turbopack by default, so the conventional
 *    copy-webpack-plugin + DefinePlugin setup is unavailable. Assets are copied to
 *    public/cesium by scripts/copy-cesium-assets.mjs instead.
 *
 * 2. CESIUM_BASE_URL MUST BE SET FIRST. Cesium reads window.CESIUM_BASE_URL during
 *    initialisation to locate its Workers, Assets and Widgets. Assigning it before
 *    injecting the script guarantees the ordering, which a hoisted static import
 *    could not.
 *
 * 3. TURBOPACK CANNOT CORRECTLY MINIFY CESIUM 1.144 (the decisive reason).
 *    Cesium inlines binary data (compressed WASM) as string literals. When Turbopack
 *    minifies the ESM build, it rewrites some of those into TEMPLATE literals, where
 *    octal escape sequences are illegal. The emitted 4.5 MB chunk then fails to parse
 *    in the browser with:
 *
 *        SyntaxError: Octal escape sequences are not allowed in template strings.
 *
 *    The error carries no stack (it is a parse failure, not a runtime throw), the
 *    module never evaluates, and the globe silently hangs on "loading" forever. This
 *    was found by the Milestone 0 runtime test; a production build alone reports
 *    success, because the code compiles fine — it just cannot be parsed.
 *
 *    Serving the prebuilt, already-minified UMD bundle sidesteps the app bundler
 *    entirely. It is also faster to build and lets the browser cache 6 MB of engine
 *    independently of application code.
 *
 * TYPES: `import type` above is erased at compile time, so we keep full type safety
 * without the bundler ever seeing Cesium's runtime code.
 */

/** Where copy-cesium-assets.mjs places Cesium's static assets and bundle. */
const CESIUM_BASE_URL = "/cesium";
const CESIUM_SCRIPT_SRC = `${CESIUM_BASE_URL}/Cesium.js`;

export type CesiumModule = typeof CesiumNamespace;

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
    Cesium?: CesiumModule;
  }
}

let cesiumPromise: Promise<CesiumModule> | undefined;

/**
 * Load Cesium once per browser session.
 *
 * The promise is cached because React StrictMode mounts effects twice in development;
 * without it the script would be injected twice.
 */
export function loadCesium(): Promise<CesiumModule> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("CesiumJS requires a browser environment and cannot run on the server."),
    );
  }

  cesiumPromise ??= new Promise<CesiumModule>((resolve, reject) => {
    // Must be assigned before the bundle evaluates.
    window.CESIUM_BASE_URL = CESIUM_BASE_URL;

    const existing = window.Cesium;
    if (existing !== undefined) {
      resolve(existing);
      return;
    }

    const script = document.createElement("script");
    script.src = CESIUM_SCRIPT_SRC;
    script.async = true;

    script.addEventListener("load", () => {
      const loaded = window.Cesium;
      if (loaded === undefined) {
        reject(
          new Error(
            `${CESIUM_SCRIPT_SRC} loaded but did not define window.Cesium. ` +
              `The copied bundle may be corrupt; re-run "pnpm run cesium:copy".`,
          ),
        );
        return;
      }
      resolve(loaded);
    });

    script.addEventListener("error", () => {
      reject(
        new Error(
          `Failed to load ${CESIUM_SCRIPT_SRC}. Run "pnpm run cesium:copy" to ` +
            `populate public/cesium.`,
        ),
      );
    });

    document.head.append(script);
  });

  return cesiumPromise;
}

/** Cesium's widget stylesheet, served from the same copied directory as the bundle. */
export const CESIUM_WIDGET_CSS_HREF = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
