/**
 * Copy CesiumJS static assets into public/cesium.
 *
 * WHY A SCRIPT RATHER THAN A BUNDLER PLUGIN
 * Next.js 16 uses Turbopack by default, which does not support webpack plugins, so
 * the conventional copy-webpack-plugin approach is unavailable. Copying here keeps
 * next.config.ts free of bundler configuration entirely.
 *
 * WHY NOT A GLOB TOOL
 * pnpm installs into a virtual store and links packages, so `node_modules/cesium` is
 * a symlink into `node_modules/.pnpm/cesium@<version>/...`. Glob-based copiers
 * resolve that inconsistently across platforms. Resolving the package entry point
 * with Node's own resolver gives the real directory on every platform and every
 * package manager.
 */

import { copyFile, cp, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories Cesium loads at runtime relative to CESIUM_BASE_URL. */
const RUNTIME_ASSET_DIRECTORIES = ["Workers", "ThirdParty", "Assets", "Widgets"];

/**
 * The prebuilt UMD bundle, loaded via a <script> tag rather than imported.
 *
 * See cesium-loader.ts for why Cesium must not go through the app bundler.
 */
const RUNTIME_BUNDLE = "Cesium.js";

const require = createRequire(import.meta.url);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = join(appRoot, "public", "cesium");

async function main() {
  const cesiumPackageJson = require.resolve("cesium/package.json");
  const cesiumBuildDir = join(dirname(cesiumPackageJson), "Build", "Cesium");

  const buildDirExists = await stat(cesiumBuildDir)
    .then((entry) => entry.isDirectory())
    .catch(() => false);

  if (!buildDirExists) {
    throw new Error(
      `Cesium build output not found at ${cesiumBuildDir}. ` +
        `Run "pnpm install" before building the web app.`,
    );
  }

  // Clean first so a Cesium upgrade cannot leave stale assets behind, which would
  // produce a version mismatch between the loaded module and its workers.
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });

  for (const directory of RUNTIME_ASSET_DIRECTORIES) {
    const source = join(cesiumBuildDir, directory);
    const exists = await stat(source)
      .then((entry) => entry.isDirectory())
      .catch(() => false);

    if (!exists) {
      throw new Error(
        `Expected Cesium asset directory "${directory}" at ${source}. ` +
          `The Cesium package layout may have changed.`,
      );
    }

    await cp(source, join(destinationRoot, directory), {
      recursive: true,
      // Follow the pnpm symlink and copy real files: Vercel and most container
      // builds do not preserve symlinks into node_modules.
      dereference: true,
    });
  }

  const bundleSource = join(cesiumBuildDir, RUNTIME_BUNDLE);
  const bundleExists = await stat(bundleSource)
    .then((entry) => entry.isFile())
    .catch(() => false);

  if (!bundleExists) {
    throw new Error(
      `Expected the prebuilt Cesium bundle at ${bundleSource}. ` +
        `The Cesium package layout may have changed.`,
    );
  }

  await copyFile(bundleSource, join(destinationRoot, RUNTIME_BUNDLE));

  console.log(
    `Copied Cesium ${RUNTIME_BUNDLE} and assets ` +
      `(${RUNTIME_ASSET_DIRECTORIES.join(", ")}) to public/cesium`,
  );
}

await main();
