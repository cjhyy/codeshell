import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSettingsRecoveryArgs, runSettingsRecoveryCli } from "./settings-recovery-cli.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "server-recovery-"));
  roots.push(root);
  return root;
};
const hash = "a".repeat(64);

test("help avoids even resolving the working directory and malformed arguments never echo values", async () => {
  let output = "",
    error = "";
  const io = {
    cwd: () => {
      throw new Error("must not resolve cwd");
    },
    write: (text: string) => {
      output += text;
    },
    error: (text: string) => {
      error += text;
    },
  };
  expect(await runSettingsRecoveryCli(["--help"], io)).toBe(0);
  expect(output).toContain("Stop the project");
  expect(error).toBe("");
  output = "";
  expect(await runSettingsRecoveryCli(["inspect", "--private-secret=do-not-echo"], io)).toBe(1);
  expect(output).toBe("");
  expect(error).not.toContain("private-secret");
  expect(error).not.toContain("do-not-echo");
});

test("ambiguous, cross-action and incomplete options are rejected before recovery", () => {
  for (const args of [
    [],
    ["inspect", "extra"],
    ["unknown"],
    ["inspect", "--scope", "user"],
    ["inspect", "--project", ""],
    ["inspect", "--project", "one", "--project", "two"],
    ["inspect", "--backup-id", "id"],
    ["inspect", "--expected-revision", hash],
    ["repair", "--from", "file"],
    ["repair", "--from", "file", "--expected-revision", hash],
    ["repair", "--from", "file", "--expected-revision", "invalid", "--candidate-sha256", hash],
    ["restore", "--backup-id", "id"],
    ["restore", "--backup-id", "id", "--expected-revision", hash, "--from", "file"],
  ])
    expect(() => parseSettingsRecoveryArgs(args, () => "/project")).toThrow(
      "Invalid recovery arguments",
    );
  expect(parseSettingsRecoveryArgs(["inspect", "--scope=local"], () => "/project")).toEqual({
    action: "inspect",
    cwd: "/project",
    scope: "local",
    candidatePath: undefined,
  });
});

test("server-only command inspects without writes and repairs/restores exact bytes without leaking values", async () => {
  const root = temporary();
  const call = async (args: string[]) => {
    let output = "",
      errors = "";
    const code = await runSettingsRecoveryCli(args, {
      cwd: () => root,
      write: (text) => {
        output += text;
      },
      error: (text) => {
        errors += text;
      },
    });
    expect(output + errors).not.toContain("private-fixture-value");
    return { code, errors, result: output ? JSON.parse(output) : undefined };
  };
  expect((await call(["inspect"])).result.status).toBe("missing");
  expect(readdirSync(root)).toEqual([]);
  const state = join(root, ".code-shell");
  mkdirSync(state);
  const damaged = '{"env":{"PRIVATE":"private-fixture-value"},';
  writeFileSync(join(state, "settings.json"), damaged);
  const reviewed = join(root, "reviewed.json");
  const candidate = '{"model":"reviewed","env":{"PRIVATE":"private-fixture-value"}}\n';
  writeFileSync(reviewed, candidate);
  const inspection = await call(["inspect", "--from", reviewed]);
  expect(inspection.code).toBe(0);
  expect(inspection.result.status).toBe("invalid_syntax");
  expect(readdirSync(state)).toEqual(["settings.json"]);
  const args = [
    "repair",
    "--from",
    reviewed,
    "--expected-revision",
    inspection.result.revision,
    "--candidate-sha256",
    inspection.result.candidate.sha256,
  ];
  const repaired = await call(args);
  expect(repaired.code).toBe(0);
  expect(repaired.result.status).toBe("valid");
  expect(readFileSync(join(state, "settings.json"), "utf8")).toBe(candidate);
  const stale = await call(args);
  expect(stale.code).toBe(1);
  expect(stale.errors).toContain("configuration changed");
  const restored = await call([
    "restore",
    "--backup-id",
    repaired.result.backupId,
    "--expected-revision",
    repaired.result.revision,
  ]);
  expect(restored.code).toBe(0);
  expect(restored.result.status).toBe("invalid_syntax");
  expect(readFileSync(join(state, "settings.json"), "utf8")).toBe(damaged);
});

test("explicit project and local scope never repair the current directory or project layer", async () => {
  const unrelated = temporary(),
    project = temporary();
  mkdirSync(join(project, ".code-shell"));
  writeFileSync(join(project, ".code-shell", "settings.json"), '{"model":"keep"}');
  writeFileSync(join(project, ".code-shell", "settings.local.json"), '{"panelAppPins":null}');
  let output = "";
  expect(
    await runSettingsRecoveryCli(["inspect", "--project", project, "--scope", "local"], {
      cwd: () => unrelated,
      write: (text) => {
        output = text;
      },
    }),
  ).toBe(0);
  expect(JSON.parse(output).status).toBe("invalid_settings");
  expect(JSON.parse(output).scope).toBe("local");
  expect(readdirSync(unrelated)).toEqual([]);
  expect(readFileSync(join(project, ".code-shell", "settings.json"), "utf8")).toBe(
    '{"model":"keep"}',
  );
});
