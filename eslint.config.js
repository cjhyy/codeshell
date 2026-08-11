import js from "@eslint/js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const toPosixPath = (value) => value.split(path.sep).join("/");
const packageRoot = (...parts) => `${toPosixPath(path.join(repoRoot, ...parts))}/`;

const coreSrcRoot = packageRoot("packages", "core", "src");
const tuiRoot = packageRoot("packages", "tui");
const desktopRoot = packageRoot("packages", "desktop");
const desktopRendererRoot = packageRoot("packages", "desktop", "src", "renderer");
const coreRoot = packageRoot("packages", "core");
const workspacePackageRoots = [
  "link",
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
  "@cjhyy/code-shell-core/browser/panel-app-runtime",
  "@cjhyy/code-shell-web",
]);

function isInsideFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return true;
    }
  }
  return false;
}

function isProcessMember(node, property) {
  return (
    node?.type === "MemberExpression" &&
    node.computed === false &&
    node.object?.type === "Identifier" &&
    node.object.name === "process" &&
    node.property?.type === "Identifier" &&
    node.property.name === property
  );
}

const syncFsMethods = new Set([
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "closeSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "fchmodSync",
  "fchownSync",
  "fdatasyncSync",
  "fstatSync",
  "fsyncSync",
  "ftruncateSync",
  "futimesSync",
  "lchmodSync",
  "lchownSync",
  "linkSync",
  "lstatSync",
  "lutimesSync",
  "mkdirSync",
  "mkdtempSync",
  "openSync",
  "opendirSync",
  "readFileSync",
  "readdirSync",
  "readlinkSync",
  "readSync",
  "readvSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "statfsSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
  "writeSync",
  "writevSync",
]);

const noSyncFsRule = {
  meta: { type: "problem", messages: { forbidden: "avoid synchronous filesystem I/O" } },
  create(context) {
    const importedNames = new Set();
    const namespaceNames = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "node:fs" && node.source.value !== "fs") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            syncFsMethods.has(specifier.imported.name)
          ) {
            importedNames.add(specifier.local.name);
          } else if (
            specifier.type === "ImportNamespaceSpecifier" ||
            specifier.type === "ImportDefaultSpecifier"
          ) {
            namespaceNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const direct = node.callee.type === "Identifier" && importedNames.has(node.callee.name);
        const member =
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          namespaceNames.has(node.callee.object.name) &&
          node.callee.property.type === "Identifier" &&
          syncFsMethods.has(node.callee.property.name);
        if (direct || member) context.report({ node, messageId: "forbidden" });
      },
    };
  },
};

const noProcessExitRule = {
  meta: { type: "problem", messages: { forbidden: "set exitCode or use the host exit seam" } },
  create: (context) => ({
    CallExpression(node) {
      if (isProcessMember(node.callee, "exit")) context.report({ node, messageId: "forbidden" });
    },
  }),
};

const noProcessCwdRule = {
  meta: { type: "problem", messages: { forbidden: "use the injected workspace cwd" } },
  create: (context) => ({
    CallExpression(node) {
      if (isProcessMember(node.callee, "cwd")) context.report({ node, messageId: "forbidden" });
    },
  }),
};

const noProcessEnvTopLevelRule = {
  meta: { type: "problem", messages: { forbidden: "read process.env inside a function" } },
  create: (context) => ({
    MemberExpression(node) {
      if (isProcessMember(node, "env") && !isInsideFunction(node)) {
        context.report({ node, messageId: "forbidden" });
      }
    },
  }),
};

const noTopLevelDynamicImportRule = {
  meta: { type: "problem", messages: { forbidden: "move dynamic import inside a function" } },
  create: (context) => ({
    ImportExpression(node) {
      if (!isInsideFunction(node)) context.report({ node, messageId: "forbidden" });
    },
  }),
};

const noTopLevelSideEffectsRule = {
  meta: { type: "problem", messages: { forbidden: "move module initialization behind a seam" } },
  create: (context) => ({
    ExpressionStatement(node) {
      if (node.parent.type === "Program" && typeof node.directive !== "string") {
        context.report({ node, messageId: "forbidden" });
      }
    },
  }),
};

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
        "renderer must not import codeshell packages at runtime — talk to main via window.codeshell.* (type-only imports are allowed)",
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
          isCodeShellPackage(specifier) ||
          (specifier.startsWith(".") &&
            workspacePackageRoots.some(
              (root) => root !== desktopRoot && resolvesInsideRoot(filename, specifier, root),
            ))
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
          "no-sync-fs": noSyncFsRule,
          "no-top-level-side-effects": noTopLevelSideEffectsRule,
          "no-top-level-dynamic-import": noTopLevelDynamicImportRule,
          "no-process-exit": noProcessExitRule,
          "no-process-cwd": noProcessCwdRule,
          "no-process-env-top-level": noProcessEnvTopLevelRule,
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
              regex: "^@cjhyy/code-shell-core(?:$|/(?!browser/panel-app-runtime$).+)",
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
  {
    files: [
      "packages/desktop/src/renderer/**/*.{test,spec}.{ts,tsx}",
      "packages/desktop/src/renderer/test-utils/**/*.{ts,tsx}",
    ],
    rules: {
      // Test harnesses may reuse browser-safe source fixtures directly. The
      // production renderer override above remains strict for shipped code.
      "custom-rules/codeshell-boundary-imports": "off",
    },
  },
  {
    files: ["packages/tui/src/render/**/*.{ts,tsx}"],
    ignores: ["packages/tui/src/render/**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "custom-rules/no-sync-fs": "error",
      "custom-rules/no-top-level-side-effects": "error",
      "custom-rules/no-top-level-dynamic-import": "error",
      "custom-rules/no-process-exit": "error",
      "custom-rules/no-process-cwd": "error",
      "custom-rules/no-process-env-top-level": "error",
    },
  },
  {
    files: ["packages/desktop/resources/chrome-extension/**/*.js"],
    languageOptions: {
      globals: {
        chrome: "readonly",
        document: "readonly",
      },
    },
  },
];
