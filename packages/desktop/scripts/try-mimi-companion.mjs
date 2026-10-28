import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "out/preview-mimi-companion.mjs");
await build({
  entryPoints: [resolve(root, "scripts/preview-mimi-companion.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: entry,
  external: ["electron"],
});
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [entry, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env,
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
