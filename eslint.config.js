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
const workspacePackageRoots = [
  "core",
  "coding",
  "arena",
  "pet",
  "server",
  "web",
  "tui",
  "chat",
  "cdp",
  "desktop",
].map((name) => packageRoot("packages", name));
const capabilityPackageRoots = ["coding", "arena", "pet"].map((name) => ({
  name,
  root: packageRoot("packages", name),
}));

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

function isCodeShellPackage(specifier) {
  return specifier === "@cjhyy/code-shell" || specifier.startsWith("@cjhyy/code-shell-");
}

const rendererBrowserSafeRuntimeImports = new Set([
  "@cjhyy/code-shell-core/browser/plugin-runtime",
]);

const codeshellBoundaryImportsRule = {
  meta: {
    type: "problem",
    messages: {
      coreToTui: "core must not import tui",
      corePackageImport:
        "core source must use relative self-imports and must not depend on another CodeShell workspace package",
      capabilityToCoreEntry:
        "capability packages must import core through @cjhyy/code-shell-core/extension",
      capabilityToWorkspace:
        "capability packages must not depend on another CodeShell product or host package",
      rendererToCodeshell:
        "renderer must not import codeshell packages at runtime — talk to main via window.codeShell.* (type-only imports are allowed)",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const capabilityPackage = capabilityPackageRoots.find(({ root }) =>
      isInsideRoot(filename, root),
    );
    const isTestFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename);

    function check(node, specifier, isTypeOnly) {
      if (typeof specifier !== "string") return;

      if (isInsideRoot(filename, coreSrcRoot)) {
        const isCoreSelfImport =
          specifier === "@cjhyy/code-shell-core" || specifier.startsWith("@cjhyy/code-shell-core/");
        if (
          matchesPackage(specifier, ["@cjhyy/code-shell-tui"]) ||
          resolvesInsideRoot(filename, specifier, tuiRoot)
        ) {
          context.report({ node, messageId: "coreToTui" });
        } else if (
          (isCodeShellPackage(specifier) && !(isTestFile && isCoreSelfImport)) ||
          (specifier.startsWith(".") &&
            workspacePackageRoots.some(
              (root) => root !== coreRoot && resolvesInsideRoot(filename, specifier, root),
            ))
        ) {
          context.report({ node, messageId: "corePackageImport" });
        }
        return;
      }

      if (capabilityPackage && !isTestFile) {
        const isCodingWorkerCompositionEntry =
          capabilityPackage.name === "coding" &&
          filename.endsWith("/packages/coding/src/bin/agent-server-stdio.ts") &&
          specifier === "@cjhyy/code-shell-core/bin/agent-server-stdio";
        if (
          (specifier === "@cjhyy/code-shell-core" ||
            specifier.startsWith("@cjhyy/code-shell-core/")) &&
          specifier !== "@cjhyy/code-shell-core/extension" &&
          !isCodingWorkerCompositionEntry
        ) {
          context.report({ node, messageId: "capabilityToCoreEntry" });
        } else if (
          (isCodeShellPackage(specifier) && !specifier.startsWith("@cjhyy/code-shell-core")) ||
          (specifier.startsWith(".") &&
            workspacePackageRoots.some(
              (root) =>
                root !== capabilityPackage.root && resolvesInsideRoot(filename, specifier, root),
            ))
        ) {
          context.report({ node, messageId: "capabilityToWorkspace" });
        }
        return;
      }

      if (isInsideRoot(filename, desktopRendererRoot)) {
        if (isTypeOnly) return;
        if (rendererBrowserSafeRuntimeImports.has(specifier)) return;
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
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value, node.exportKind === "type");
      },
      ExportAllDeclaration(node) {
        check(node, node.source?.value, node.exportKind === "type");
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
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 3,
        },
      ],
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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@cjhyy/code-shell-tui", "@cjhyy/code-shell-tui/*"],
              message: "core must not import tui",
            },
            {
              group: ["**/packages/tui/**"],
              message: "core must not import tui (relative path)",
            },
          ],
        },
      ],
      "custom-rules/codeshell-boundary-imports": "error",
    },
  },
  {
    files: [
      "packages/coding/src/**/*.{ts,tsx}",
      "packages/arena/src/**/*.{ts,tsx}",
      "packages/pet/src/**/*.{ts,tsx}",
    ],
    rules: {
      "custom-rules/codeshell-boundary-imports": "error",
    },
  },
  {
    files: ["packages/desktop/src/renderer/**/*.{ts,tsx}"],
    rules: {
      // The renderer talks to main via window.codeShell.* and may runtime-
      // import only explicitly reviewed browser-safe entries. Type-only
      // imports are erased, so renderer code may still share core contracts.
      // Use @typescript-eslint's variant for allowTypeImports.
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@cjhyy/code-shell-core(?:$|/(?!browser/plugin-runtime$).+)",
              allowTypeImports: true,
              message:
                "renderer may runtime-import only reviewed core browser entry points; use window.codeShell.* for host capabilities",
            },
            {
              group: ["@cjhyy/code-shell-tui", "@cjhyy/code-shell-tui/*", "@cjhyy/code-shell"],
              allowTypeImports: true,
              message:
                "renderer must not import codeshell packages at runtime — talk to main via window.codeShell.* (type-only imports are allowed)",
            },
          ],
        },
      ],
      "custom-rules/codeshell-boundary-imports": "error",
    },
  },
];
