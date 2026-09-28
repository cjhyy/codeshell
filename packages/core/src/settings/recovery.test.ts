import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectProjectSettingsRecovery as inspect,
  repairProjectSettings as repair,
  restoreProjectSettings as restore,
} from "./recovery.js";
import { SettingsManager } from "./manager.js";
let cwd: string, state: string, candidatePath: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "settings-recovery-"));
  state = join(cwd, ".code-shell");
  candidatePath = join(cwd, "candidate.json");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
function initial(bytes: string | Buffer, name = "settings.json") {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, name), bytes);
}
function proposal(value: unknown = { model: "reviewed", extension: { custom: "keep" } }) {
  writeFileSync(candidatePath, JSON.stringify(value));
  const result = inspect({ cwd, candidatePath });
  return {
    cwd,
    candidatePath,
    expectedRevision: result.revision,
    candidateSha256: result.candidate!.sha256,
  };
}
describe("trusted settings recovery", () => {
  test("inspection is read-only, missing state remains missing and no values reach diagnostics", () => {
    const result = inspect({ cwd });
    expect(result.status).toBe("missing");
    expect(existsSync(state)).toBe(false);
    initial('{"env":{"PRIVATE_TOKEN":"do-not-print"},');
    const broken = inspect({ cwd });
    expect(broken.status).toBe("invalid_syntax");
    expect(JSON.stringify(broken)).not.toContain("do-not-print");
    expect(readdirSync(state)).toEqual(["settings.json"]);
  });
  test("repair backs up exact malformed bytes and rollback backs up the repaired configuration", () => {
    const broken = Buffer.from([0xff, 0xfe, 0, 123]);
    initial(broken);
    const args = proposal();
    const result = repair(args);
    expect(result.status).toBe("valid");
    expect(readFileSync(join(state, "settings.json"))).toEqual(readFileSync(candidatePath));
    const archived = JSON.parse(
      readFileSync(join(state, "settings-recovery", `${result.backupId}.json`), "utf8"),
    );
    expect(Buffer.from(archived.original, "base64")).toEqual(broken);
    const rollback = restore({ cwd, backupId: result.backupId, expectedRevision: result.revision });
    expect(readFileSync(join(state, "settings.json"))).toEqual(broken);
    expect(rollback.status).toBe("invalid_syntax");
    const again = restore({
      cwd,
      backupId: rollback.backupId,
      expectedRevision: rollback.revision,
    });
    expect(again.status).toBe("valid");
    if (process.platform !== "win32") {
      expect(lstatSync(join(state, "settings.json")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(state, "settings-recovery")).mode & 0o777).toBe(0o700);
      expect(
        lstatSync(join(state, "settings-recovery", `${result.backupId}.json`)).mode & 0o777,
      ).toBe(0o600);
    }
  });
  test("new JSON shadows YAML without editing it; rollback removes that new file", () => {
    const yaml = "model: existing\ncustom: preserve\n";
    initial(yaml, "settings.yaml");
    expect(inspect({ cwd }).activeFile).toBe("settings.yaml");
    const result = repair(proposal());
    expect(readFileSync(join(state, "settings.yaml"), "utf8")).toBe(yaml);
    const undone = restore({ cwd, backupId: result.backupId, expectedRevision: result.revision });
    expect(undone.activeFile).toBe("settings.yaml");
    expect(existsSync(join(state, "settings.json"))).toBe(false);
  });
  test("reviewed complete configuration preserves protected fields and unknown extensions", () => {
    initial('{"panelAppPins":null}');
    expect(inspect({ cwd }).status).toBe("invalid_settings");
    const args = proposal({
      env: { PRIVATE_TOKEN: "reviewed-secret" },
      panelAppPins: {},
      futureExtension: { opaque: [1, 2, 3] },
    });
    const result = repair(args);
    expect(result.status).toBe("valid");
    expect(new SettingsManager(cwd).getForScope("project", cwd, { strict: true })).toEqual(
      JSON.parse(readFileSync(candidatePath, "utf8")),
    );
    expect(JSON.stringify(result)).not.toContain("reviewed-secret");
  });
  test("stale configuration and changed proposal are rejected before backup or replacement", () => {
    initial("{}");
    const args = proposal();
    initial('{"model":"other-writer"}');
    expect(() => repair(args)).toThrow("configuration changed");
    expect(existsSync(join(state, "settings-recovery"))).toBe(false);
    const fresh = { ...args, expectedRevision: inspect({ cwd }).revision };
    writeFileSync(candidatePath, '{"model":"unreviewed"}');
    expect(() => repair(fresh)).toThrow("candidate changed");
    expect(readFileSync(join(state, "settings.json"), "utf8")).toContain("other-writer");
  });
  test("a new YAML alternative invalidates a reviewed revision even when JSON still wins", () => {
    initial("{}");
    const args = proposal();
    initial("model: secondary", "settings.yaml");
    expect(() => repair(args)).toThrow("configuration changed");
  });
  test("invalid candidates never replace or archive configuration", () => {
    initial("{}");
    for (const value of ["[1]", '{"panelAppPins":null}', '{"__proto__":{"x":1}}', '{"model":']) {
      writeFileSync(candidatePath, value);
      const result = inspect({ cwd, candidatePath });
      expect(result.candidate!.status).not.toBe("valid");
      expect(() =>
        repair({
          cwd,
          candidatePath,
          expectedRevision: result.revision,
          candidateSha256: result.candidate!.sha256,
        }),
      ).toThrow("not valid");
    }
    expect(readdirSync(state)).toEqual(["settings.json"]);
  });
  test("local scope is independent and another scope cannot consume its backup", () => {
    initial('{"model":"project"}');
    initial("broken", "settings.local.json");
    writeFileSync(candidatePath, '{"model":"local"}');
    const viewed = inspect({ cwd, scope: "local", candidatePath });
    const result = repair({
      cwd,
      scope: "local",
      candidatePath,
      expectedRevision: viewed.revision,
      candidateSha256: viewed.candidate!.sha256,
    });
    expect(readFileSync(join(state, "settings.json"), "utf8")).toBe('{"model":"project"}');
    expect(() =>
      restore({ cwd, backupId: result.backupId, expectedRevision: inspect({ cwd }).revision }),
    ).toThrow("project and scope");
  });
  test("modified YAML makes rollback unsafe and requires a reviewed repair instead", () => {
    initial("model: old", "settings.yaml");
    const result = repair(proposal());
    initial("model: changed", "settings.yaml");
    expect(() =>
      restore({ cwd, backupId: result.backupId, expectedRevision: inspect({ cwd }).revision }),
    ).toThrow("YAML alternatives changed");
    expect(readFileSync(join(state, "settings.json"))).toEqual(readFileSync(candidatePath));
  });
  test("damaged backup and traversal ID cannot be used for rollback", () => {
    initial("{}");
    const result = repair(proposal());
    const file = join(state, "settings-recovery", `${result.backupId}.json`);
    const archive = JSON.parse(readFileSync(file, "utf8"));
    archive.original = Buffer.from("altered").toString("base64");
    writeFileSync(file, JSON.stringify(archive));
    expect(() =>
      restore({ cwd, backupId: result.backupId, expectedRevision: result.revision }),
    ).toThrow("damaged");
    expect(() =>
      restore({ cwd, backupId: "../../candidate", expectedRevision: result.revision }),
    ).toThrow("invalid backup id");
  });
  test("unsafe directory, config file, candidate and backup paths are not followed", () => {
    const outside = join(cwd, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), "{}");
    symlinkSync(outside, state, "dir");
    expect(() => inspect({ cwd })).toThrow();
    rmSync(state);
    mkdirSync(state);
    symlinkSync(join(outside, "settings.json"), join(state, "settings.json"));
    expect(() => inspect({ cwd })).toThrow();
    rmSync(join(state, "settings.json"));
    initial("{}");
    symlinkSync(join(outside, "settings.json"), candidatePath);
    expect(() => inspect({ cwd, candidatePath })).toThrow();
    rmSync(candidatePath);
    const args = proposal();
    symlinkSync(outside, join(state, "settings-recovery"), "dir");
    expect(() => repair(args)).toThrow();
    expect(readFileSync(join(state, "settings.json"), "utf8")).toBe("{}");
    expect(readdirSync(outside)).toEqual(["settings.json"]);
  });
  test("failed backup creation leaves the original untouched", () => {
    initial("broken");
    const args = proposal();
    writeFileSync(join(state, "settings-recovery"), "occupied");
    expect(() => repair(args)).toThrow();
    expect(readFileSync(join(state, "settings.json"), "utf8")).toBe("broken");
  });
  test("oversized files fail before overwrite and private backups never use a public directory", () => {
    initial(Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(() => inspect({ cwd })).toThrow("bounded regular file");
    initial("{}");
    const args = proposal();
    mkdirSync(join(state, "settings-recovery"), { mode: 0o755 });
    if (process.platform !== "win32") {
      chmodSync(join(state, "settings-recovery"), 0o755);
      expect(() => repair(args)).toThrow("private");
      expect(readFileSync(join(state, "settings.json"), "utf8")).toBe("{}");
    }
  });
  test("cyclic YAML and an empty project path fail without expanding or changing files", () => {
    initial("loop: &loop {left: *loop, right: *loop}\n", "settings.yaml");
    expect(inspect({ cwd }).status).toBe("invalid_settings");
    expect(() => inspect({ cwd: "" })).toThrow("explicit project directory");
    expect(readdirSync(state)).toEqual(["settings.yaml"]);
  });
  test("backup bytes are excluded from ordinary Git staging", () => {
    initial("broken");
    execFileSync("git", ["init", "-q"], { cwd });
    const result = repair(proposal());
    const backup = `.code-shell/settings-recovery/${result.backupId}.json`;
    expect(
      execFileSync("git", ["check-ignore", "--", backup], { cwd, encoding: "utf8" }).trim(),
    ).toBe(backup);
    writeFileSync(join(state, "settings-recovery", ".gitignore"), "!*.json\n");
    expect(() => repair(proposal())).toThrow("ignore rule");
  });
  test("fresh project can be repaired and returned to a missing configuration", () => {
    const result = repair(proposal());
    expect(result.status).toBe("valid");
    const undone = restore({ cwd, backupId: result.backupId, expectedRevision: result.revision });
    expect(undone.status).toBe("missing");
  });
  test("two independent writers cannot both replace the same reviewed revision", async () => {
    initial("broken");
    const args = proposal();
    const module = fileURLToPath(new URL("./recovery.ts", import.meta.url));
    const script = join(cwd, "writer.mjs");
    writeFileSync(
      script,
      `import {repairProjectSettings} from ${JSON.stringify(module)};try{repairProjectSettings(JSON.parse(process.argv[2]));process.exitCode=0}catch{process.exitCode=3}`,
    );
    const run = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [script, JSON.stringify(args)], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", resolve);
      });
    expect((await Promise.all([run(), run()])).sort()).toEqual([0, 3]);
    expect(
      readdirSync(join(state, "settings-recovery")).filter((name) => name.endsWith(".json")),
    ).toHaveLength(1);
  });
});
