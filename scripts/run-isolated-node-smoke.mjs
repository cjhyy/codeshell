import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "./bun-test-completion.mjs";

// Node --test without files discovers tests across cwd, including native ones.
// Validate the complete finite selection before creating HOME or spawning Node.
function validateExplicitTests(args) {
  const selectors = new Set(["--test-name-pattern", "--test-skip-pattern"]);
  const seen = new Set();
  let files = 0;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/u.test(value)) {
      throw new Error("Node --test requires bounded explicit test files");
    }
    if (value.startsWith("-")) {
      const equals = value.indexOf("=");
      const flag = equals < 0 ? value : value.slice(0, equals);
      if (!selectors.has(flag) || seen.has(flag) || files) {
        throw new Error("Node --test only permits name/skip selectors before explicit test files");
      }
      const pattern = equals < 0 ? args[++index] : value.slice(equals + 1);
      if (
        typeof pattern !== "string" ||
        !pattern ||
        pattern.length > 2048 ||
        pattern.startsWith("-") ||
        /[\0\r\n]/u.test(pattern)
      ) {
        throw new Error("Node --test selector requires one bounded pattern");
      }
      seen.add(flag);
      continue;
    }
    if ([...value].some((character) => "*?[]{}".includes(character))) {
      throw new Error("Node --test discovery patterns are forbidden; list exact files");
    }
    let metadata;
    try {
      metadata = lstatSync(value);
    } catch {
      throw new Error("Node --test requires existing explicit regular test files");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Node --test directories, links and special files are forbidden");
    }
    if (++files > 128) throw new Error("Node --test explicit file limit exceeded");
  }
  if (!files) throw new Error("Node --test requires at least one explicit regular test file");
}

// Launch before the smoke imports Core, including when this executable is
// Electron's Node mode. The smoke never sees the operator's Host environment.
let directory;
try {
  const command = process.argv.slice(2);
  const privateKeyring = command[0] === "--private-keyring";
  if (privateKeyring) command.shift();
  const [entry, ...args] = command;
  if (!entry) throw new Error("usage: run-isolated-node-smoke.mjs <entry> [args...]");
  if (entry === "--test") validateExplicitTests(args);
  else if (entry.startsWith("-")) throw new Error("Unsupported isolated Node entry option");
  directory = mkdtempSync(join(tmpdir(), "codeshell-native-smoke-"));
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
  if (directory) rmSync(directory, { recursive: true, force: true });
}
