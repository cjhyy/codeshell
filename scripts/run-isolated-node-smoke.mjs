import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

// Launch before the smoke imports Core, including when this executable is
// Electron's Node mode. The smoke never sees the operator's Host environment.
const directory = mkdtempSync(join(tmpdir(), "codeshell-native-smoke-"));
try {
  const command = process.argv.slice(2);
  const privateKeyring = command[0] === "--private-keyring";
  if (privateKeyring) command.shift();
  const [entry, ...args] = command;
  if (!entry) throw new Error("usage: run-isolated-node-smoke.mjs <entry> [args...]");
  const env = createBunTestEnvironment(process.env, directory);
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  // Establish an owned SecretService only after the inherited session was
  // scrubbed. Ordinary unit/native smokes keep their existing isolation.
  const linuxKeyring = privateKeyring && process.platform === "linux";
  const child = spawn(
    linuxKeyring ? "bash" : process.execPath,
    linuxKeyring
      ? [
          fileURLToPath(new URL("./run-electron-e2e-keyring.sh", import.meta.url)),
          process.execPath,
          entry,
          ...args,
        ]
      : [entry, ...args],
    { env, stdio: "inherit" },
  );
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
