import { equal, match, deepStrictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { suiteCommands } from "./run-e2e-suite.mjs";

const runner = fileURLToPath(new URL("./run-e2e-suite.mjs", import.meta.url));

test("the CI suite runs the exact test:e2e commands in order", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const commands = suiteCommands(manifest.scripts["test:e2e"]);
  equal(commands.join(" && "), manifest.scripts["test:e2e"].trim());
  equal(commands.length > 10, true);
});

test("one failing command is named, later commands still run, and the run fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-e2e-suite-"));
  try {
    const marker = join(directory, "ran.txt");
    const append = (label) => `node -e "require('fs').appendFileSync('ran.txt','${label}\\n')"`;
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          "test:e2e": [
            append("first"),
            `${append("second")} && node -e "process.exit(3)"`,
            append("third"),
          ].join(" && "),
        },
      }),
    );
    const summary = join(directory, "summary.md");
    const result = spawnSync(
      process.execPath,
      [runner, "--package", join(directory, "package.json")],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary },
      },
    );
    equal(result.status, 1);
    // Every command ran, including the one after the failure.
    deepStrictEqual(readFileSync(marker, "utf8").trim().split("\n"), ["first", "second", "third"]);
    match(
      result.stdout,
      /::error title=Electron E2E::node -e "process\.exit\(3\)" exited with code 3/,
    );
    match(result.stdout, /::group::/);
    const table = readFileSync(summary, "utf8");
    match(table, /\| ✗ \| `node -e "process\.exit\(3\)"` \|/);
    equal(table.split("✓").length - 1, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
