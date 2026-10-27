#!/usr/bin/env node
// CI runner for `test:e2e`. Locally the script stays one `&&` chain that stops at the
// first failure. On the runner that hid which suite failed (a silent exit 1 after the
// last "passed" line) and skipped every later suite. This runs the same commands, in
// order, each in its own log group; it names every failure and fails at the end.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The commands of one `&&` chain, exactly as package.json lists them. */
export function suiteCommands(chain) {
  const commands = chain.split("&&").map((part) => part.trim());
  if (!commands.length || commands.some((part) => !part))
    throw new Error("test:e2e must be a non-empty && chain of commands");
  return commands;
}

function run(command, cwd) {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    child.on("error", () => done(127));
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

async function main() {
  const argv = process.argv.slice(2),
    at = argv.indexOf("--package"),
    manifestPath = resolve(
      at >= 0 ? argv[at + 1] : fileURLToPath(new URL("../package.json", import.meta.url)),
    ),
    cwd = dirname(manifestPath),
    github = process.env.GITHUB_ACTIONS === "true";
  const commands = suiteCommands(
    JSON.parse(readFileSync(manifestPath, "utf8")).scripts["test:e2e"],
  );
  const results = [];
  for (const command of commands) {
    if (github) console.log(`::group::${command}`);
    const started = Date.now(),
      code = await run(command, cwd),
      seconds = (Date.now() - started) / 1000;
    if (github) console.log("::endgroup::");
    results.push({ command, code, seconds });
    if (code !== 0) {
      const message = `${command} exited with code ${code}`;
      console.log(github ? `::error title=Electron E2E::${message}` : `FAILED: ${message}`);
    }
  }
  const failed = results.filter((result) => result.code !== 0);
  const lines = [
    "| | Suite | Seconds |",
    "| --- | --- | ---: |",
    ...results.map(
      (result) =>
        `| ${result.code === 0 ? "✓" : "✗"} | \`${result.command}\` | ${result.seconds.toFixed(1)} |`,
    ),
  ];
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Electron E2E\n\n${lines.join("\n")}\n`);
  console.log(`Electron E2E: ${results.length - failed.length}/${results.length} suites passed`);
  for (const result of failed) console.log(`  failed: ${result.command} (exit ${result.code})`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
