import { orbitCore } from "@orbitwatch/eslint-config";

export default [
  { ignores: ["dist/**", "test-fixtures/**"] },
  ...orbitCore,
  {
    // Tests may read fixture files from disk, so Node built-ins are allowed there.
    files: ["**/*.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
