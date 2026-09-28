import { afterEach, beforeEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectProjectSettingsRecovery,
  repairProjectSettings,
  restoreProjectSettings,
} from "../../../../core/src/settings/recovery.js";
import { createSettingsRecoveryCommand, isSettingsRecoveryCommand } from "./settings-recovery.js";
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "recovery-cli-"));
  mkdirSync(join(cwd, ".code-shell"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const operations = {
  inspect: inspectProjectSettingsRecovery,
  repair: repairProjectSettings,
  restore: restoreProjectSettings,
};
async function run(args: string[]) {
  let text = "";
  const command = createSettingsRecoveryCommand({
    operations,
    cwd: () => cwd,
    write: (value) => {
      text += value;
    },
  });
  command.exitOverride();
  for (const child of command.commands) child.exitOverride();
  await command.parseAsync(args, { from: "user" });
  return JSON.parse(text);
}
test("CLI inspection, reviewed repair and exact rollback use explicit revisions", async () => {
  const config = join(cwd, ".code-shell", "settings.json"),
    candidate = join(cwd, "fixed.json");
  writeFileSync(config, '{"env":{"SECRET":"keep-private"},');
  writeFileSync(candidate, '{"model":"fixed"}');
  const before = await run(["inspect", "--from", candidate]);
  expect(before.status).toBe("invalid_syntax");
  expect(JSON.stringify(before)).not.toContain("keep-private");
  expect(readdirSync(join(cwd, ".code-shell"))).toEqual(["settings.json"]);
  const repaired = await run([
    "repair",
    "--from",
    candidate,
    "--expected-revision",
    before.revision,
    "--candidate-sha256",
    before.candidate.sha256,
  ]);
  expect(repaired.status).toBe("valid");
  const restored = await run([
    "restore",
    "--backup-id",
    repaired.backupId,
    "--expected-revision",
    repaired.revision,
  ]);
  expect(restored.status).toBe("invalid_syntax");
  expect(readFileSync(config, "utf8")).toBe('{"env":{"SECRET":"keep-private"},');
});
test("explicit project and local scope never silently use the caller directory", async () => {
  const project = join(cwd, "another");
  mkdirSync(project);
  mkdirSync(join(project, ".code-shell"));
  writeFileSync(join(project, ".code-shell", "settings.local.json"), "{}");
  const result = await run(["inspect", "--project", project, "--scope", "local"]);
  expect(result.scope).toBe("local");
  expect(result.activeFile).toBe("settings.local.json");
  expect(result.project.endsWith("/another")).toBe(true);
});
test("all recovery actions bypass bootstrap while unrelated commands do not", () => {
  const root = new Command("codeshell").addCommand(createSettingsRecoveryCommand({ operations }));
  const parent = root.commands[0]!;
  for (const child of parent.commands) expect(isSettingsRecoveryCommand(child)).toBe(true);
  expect(isSettingsRecoveryCommand(parent)).toBe(false);
  expect(isSettingsRecoveryCommand(root.command("repair"))).toBe(false);
});
test("repair requires both revision and candidate hash, and rejects unknown scope", async () => {
  const errors: string[] = [];
  const command = createSettingsRecoveryCommand({ operations, cwd: () => cwd });
  command.exitOverride();
  for (const child of command.commands) child.exitOverride();
  command.configureOutput({ writeErr: (text) => errors.push(text) });
  await expect(
    command.parseAsync(["repair", "--from", "missing"], { from: "user" }),
  ).rejects.toThrow();
  expect(errors.join("")).toContain("expected-revision");
  await expect(run(["inspect", "--scope", "user"])).rejects.toThrow();
});
