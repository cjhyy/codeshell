import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";

// Analyze the bundles as scripts. Unresolved require calls reach Electron's restricted
// preload loader; a polyfill or require implemented inside a bundle is an ordinary binding.
const electronModules = new Set([
  "electron",
  "electron/renderer",
  "electron/common",
]);
const removed = ["Buffer", "setImmediate", "clearImmediate"];
const sandboxImports = {
  create(context) {
    return {
      "Program:exit"() {
        for (const { identifier } of context.sourceCode.scopeManager.globalScope
          .through) {
          if (identifier.name !== "require") continue;
          const call = identifier.parent;
          if (
            call.type === "CallExpression" &&
            call.callee === identifier &&
            call.arguments.length === 1 &&
            electronModules.has(call.arguments[0].value)
          )
            continue;
          context.report({
            node: identifier,
            message: "External require must name a sandbox Electron module.",
          });
        }
      },
    };
  },
};

const directory = fileURLToPath(new URL("../out/preload/", import.meta.url));
const files = (await readdir(directory)).filter((name) =>
  name.endsWith(".cjs"),
);
for (const name of ["index", "browser-guest", "panel-app", "mimi-companion"]) {
  assert(files.includes(name + ".cjs"), `Missing compiled preload: ${name}`);
}
const linter = new Linter();
for (const name of files) {
  const messages = linter.verify(
    await readFile(join(directory, name), "utf8"),
    {
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "script",
        globals: { self: "readonly", window: "readonly", global: "readonly" },
      },
      plugins: { sandbox: { rules: { imports: sandboxImports } } },
      rules: {
        "sandbox/imports": "error",
        "no-restricted-globals": [
          "error",
          {
            globals: removed,
            checkGlobalObject: true,
            globalObjects: ["window", "self", "global"],
          },
        ],
      },
    },
  );
  assert.equal(
    messages.length,
    0,
    messages
      .map((m) => `${name}:${m.line}:${m.column} ${m.message}`)
      .join("\n"),
  );
}
console.log(
  `Verified sandbox globals and external imports in ${files.length} compiled preloads`,
);
