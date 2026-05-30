import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "*.config.js",
      "examples/**/output/**",
      "packages/desktop/out/**",
      "packages/*/dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    plugins: {
      "custom-rules": {
        rules: {
          "no-sync-fs": { create: () => ({}) },
          "no-top-level-side-effects": { create: () => ({}) },
          "no-top-level-dynamic-import": { create: () => ({}) },
          "no-process-exit": { create: () => ({}) },
          "no-process-cwd": { create: () => ({}) },
          "no-process-env-top-level": { create: () => ({}) },
        },
      },
      "react-hooks": {
        rules: {
          "exhaustive-deps": { create: () => ({}) },
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        WebSocket: "readonly",
        queueMicrotask: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": ["warn", {
        "ts-expect-error": "allow-with-description",
        "ts-ignore": true,
        "ts-nocheck": true,
        "ts-check": false,
        minimumDescriptionLength: 3,
      }],
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-case-declarations": "off",
      "no-constant-binary-expression": "warn",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["packages/core/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["@cjhyy/code-shell-tui", "@cjhyy/code-shell-tui/*"],
            message: "core must not import tui"
          },
          {
            group: ["**/packages/tui/**"],
            message: "core must not import tui (relative path)"
          }
        ]
      }]
    }
  },
  {
    files: ["packages/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      // The renderer must not take a RUNTIME dependency on the codeshell
      // packages — it talks to main via window.codeShell.*. Type-only
      // imports are erased at compile time (no runtime edge), so they're
      // allowed: the renderer can share core's StreamEvent/TaskInfo shapes
      // without bundling core. Use @typescript-eslint's variant for
      // allowTypeImports and turn the base rule off so they don't conflict.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [
          {
            group: [
              "@cjhyy/code-shell-core",
              "@cjhyy/code-shell-core/*",
              "@cjhyy/code-shell-tui",
              "@cjhyy/code-shell-tui/*",
              "@cjhyy/code-shell"
            ],
            allowTypeImports: true,
            message: "renderer must not import codeshell packages at runtime — talk to main via window.codeShell.* (type-only imports are allowed)"
          }
        ]
      }]
    }
  }
];
