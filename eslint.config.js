import js from "@eslint/js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const toPosixPath = (value) => value.split(path.sep).join("/");
const packageRoot = (...parts) => `${toPosixPath(path.join(repoRoot, ...parts))}/`;

const coreSrcRoot = packageRoot("packages", "core", "src");
const tuiRoot = packageRoot("packages", "tui");
const desktopRendererRoot = packageRoot("packages", "desktop", "src", "renderer");
const coreRoot = packageRoot("packages", "core");

function isInsideRoot(filename, root) {
  if (!filename || filename.startsWith("<")) return false;
  const normalized = toPosixPath(path.resolve(filename));
  return normalized === root.slice(0, -1) || normalized.startsWith(root);
}

function resolvesInsideRoot(filename, specifier, root) {
  if (!specifier.startsWith(".")) return false;
  const normalized = toPosixPath(path.resolve(path.dirname(filename), specifier));
  return normalized === root.slice(0, -1) || normalized.startsWith(root);
}

function matchesPackage(specifier, packageNames) {
  return packageNames.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

const codeshellBoundaryImportsRule = {
  meta: {
    type: "problem",
    messages: {
      coreToTui: "core must not import tui",
      rendererToCodeshell:
        "renderer must not import codeshell packages at runtime — talk to main via window.codeShell.* (type-only imports are allowed)",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();

    function check(node, specifier, isTypeOnly) {
      if (typeof specifier !== "string") return;

      if (isInsideRoot(filename, coreSrcRoot)) {
        if (
          matchesPackage(specifier, ["@cjhyy/code-shell-tui"]) ||
          resolvesInsideRoot(filename, specifier, tuiRoot)
        ) {
          context.report({ node, messageId: "coreToTui" });
        }
        return;
      }

      if (isInsideRoot(filename, desktopRendererRoot)) {
        if (isTypeOnly) return;
        if (
          matchesPackage(specifier, [
            "@cjhyy/code-shell-core",
            "@cjhyy/code-shell-tui",
            "@cjhyy/code-shell",
          ]) ||
          resolvesInsideRoot(filename, specifier, coreRoot) ||
          resolvesInsideRoot(filename, specifier, tuiRoot)
        ) {
          context.report({ node, messageId: "rendererToCodeshell" });
        }
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source?.value, node.importKind === "type");
      },
      ImportExpression(node) {
        check(node, node.source?.value, false);
      },
    };
  },
};

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
      "packages/web/dist-app/**",
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
          "codeshell-boundary-imports": codeshellBoundaryImportsRule,
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
      }],
      "custom-rules/codeshell-boundary-imports": "error"
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
      }],
      "custom-rules/codeshell-boundary-imports": "error"
    }
  }
];
