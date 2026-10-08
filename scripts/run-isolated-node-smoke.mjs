import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

// Launch before the smoke imports Core, including when this executable is
// Electron's Node mode. The smoke never sees the operator's Host environment.
const directory = mkdtempSync(join(tmpdir(), "codeshell-native-smoke-"));
try {
  const [entry, ...args] = process.argv.slice(2);
  if (!entry) throw new Error("usage: run-isolated-node-smoke.mjs <entry> [args...]");
  const env = createBunTestEnvironment(process.env, directory);
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: "inherit" });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal) {
    throw new Error(`Native smoke failed (${result.signal ?? result.code ?? "unknown"})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
