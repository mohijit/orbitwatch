import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * Shared ESLint configuration for OrbitWatch.
 *
 * `prettier` is last so formatting rules never fight the formatter.
 */
export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // An unexplained `any` defeats the point of strict mode. Where one is
      // genuinely required (third-party interop), silence it locally with a comment
      // explaining why — that comment is the actual deliverable.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  prettier,
);

/**
 * Extra restrictions for `packages/orbit-core`.
 *
 * The orbital engine must stay runnable in a web worker, in React Native's JS
 * runtime, in Node on the server and in tests. The moment it imports React, a DOM
 * global, Cesium or a Node built-in, one of those environments breaks — and the
 * cross-platform agreement tests stop being meaningful, because web and native would
 * no longer be running identical code.
 */
export const orbitCore = tseslint.config(...base, {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "react", message: "orbit-core must stay framework-free." },
          { name: "react-dom", message: "orbit-core must stay framework-free." },
          { name: "react-native", message: "orbit-core must stay framework-free." },
          { name: "cesium", message: "orbit-core must stay renderer-agnostic." },
        ],
        patterns: [
          {
            group: ["node:*", "fs", "path", "os", "crypto"],
            message:
              "orbit-core must run in the browser and in React Native; Node built-ins are not available there.",
          },
        ],
      },
    ],
    "no-restricted-globals": [
      "error",
      { name: "window", message: "orbit-core must not depend on the DOM." },
      { name: "document", message: "orbit-core must not depend on the DOM." },
      { name: "navigator", message: "orbit-core must not depend on the DOM." },
      { name: "localStorage", message: "orbit-core must not depend on the DOM." },
    ],
  },
});

export default base;
