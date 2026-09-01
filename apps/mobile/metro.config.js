/* eslint-env node */
const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");

/**
 * Metro in a pnpm workspace.
 *
 * Two things are not default here and both are required.
 *
 * WATCHING THE WORKSPACE. `@orbitwatch/orbit-core` and `@orbitwatch/contracts` are
 * workspace packages living outside this app's directory. Without `watchFolders`,
 * Metro neither bundles nor reloads on a change to the shared orbital code — which is
 * most of what this app actually runs.
 *
 * RESOLVING THROUGH SYMLINKS. pnpm stores one physical copy of every package and links
 * to it, so `node_modules` is a tree of symlinks rather than a flat directory. Metro is
 * told where the real roots are so it can find this app's own dependencies and the
 * workspace's.
 *
 * Hierarchical lookup is deliberately LEFT ON. The usual monorepo advice is to disable
 * it, which is right for npm and yarn: it stops a package resolving from an unexpected
 * level of a hoisted tree and ending up with two copies of React. Under pnpm it is
 * exactly wrong — a package's own dependencies live in ITS nested node_modules, and
 * disabling the walk makes them unreachable. Doing so here made expo-router fail to
 * resolve its own @react-navigation/native, presenting as a chain of apparently
 * missing packages that were all present.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

/**
 * satellite.js's WASM runtime is not bundled for native. See
 * `src/lib/wasm-unavailable.ts` for why stubbing it is the correct behaviour rather
 * than a workaround.
 */
const WASM_SUBPATHS = new Set(["#wasm-single-thread", "#wasm-multi-thread"]);
const wasmStub = path.resolve(projectRoot, "src", "lib", "wasm-unavailable.ts");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (WASM_SUBPATHS.has(moduleName)) {
    return { type: "sourceFile", filePath: wasmStub };
  }
  // `context.resolveRequest` is the rest of the chain, including Expo's own resolver.
  // Delegating through it rather than a captured reference is what keeps this hook
  // additive instead of replacing behaviour it does not know about.
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
