import { orbitCore } from "@orbitwatch/eslint-config";

export default [
  { ignores: ["dist/**", "test-fixtures/**"] },
  ...orbitCore,
  {
    // Tests may read fixture files from disk, so Node built-ins are allowed there.
    files: ["**/*.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    /*
     * Build-time tooling, not part of the published runtime.
     *
     * `src/cli/**` is excluded from tsconfig.build.json, so nothing here reaches the
     * package a browser or React Native app consumes. The restriction on Node built-ins
     * exists to keep the RUNTIME portable, and applying it to a generator that exists
     * solely to write a file on a developer's machine would be enforcing the rule
     * against its own purpose.
     */
    files: ["src/cli/**/*.ts"],
    rules: { "no-restricted-imports": "off", "no-console": "off" },
  },
];
