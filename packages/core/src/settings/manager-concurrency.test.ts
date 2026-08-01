// Settings writes must not lose each other's keys.
//
// Every SettingsManager writer read its own snapshot OUTSIDE any lock and then
// atomically renamed a full replacement file. Atomic rename prevents a torn
// file; it does nothing about a lost update. Two processes setting DIFFERENT
// keys still clobbered one another — 48 concurrent writers, each with a distinct
// key, left only 17 keys on disk.
//
// This is a real multi-writer path: the desktop settings page, the Agent
// `Config` tool, automation workers, the TUI and a second desktop instance all
// write the same files. The desktop settings service already locked the
// `.code-shell` directory; Core's writers now take the same lock, so the two
// interlock instead of racing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "./manager.js";

const MANAGER_MODULE = join(import.meta.dir, "manager.ts");

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "cs-settings-conc-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function projectSettingsPath(): string {
  return join(projectDir, ".code-shell", "settings.json");
}

function readProjectSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(projectSettingsPath(), "utf-8")) as Record<string, unknown>;
}

describe("SettingsManager concurrent writes", () => {
  test("48 processes each setting a distinct key lose nothing", async () => {
    // Seed so the file exists and carries a value nobody else touches.
    mkdirSync(join(projectDir, ".code-shell"), { recursive: true });
    writeFileSync(projectSettingsPath(), JSON.stringify({ sentinel: "keep" }, null, 2));

    const total = 48;
    const script = (key: string) => `
      import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
      const m = new SettingsManager(${JSON.stringify(projectDir)});
      m.saveProjectSetting(${JSON.stringify(key)}, 1, ${JSON.stringify(projectDir)});
    `;
    const procs = Array.from({ length: total }, (_, i) =>
      Bun.spawn([process.execPath, "-e", script(`k${i}`)], { stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const final = readProjectSettings();
    const missing: string[] = [];
    for (let i = 0; i < total; i += 1) {
      if (final[`k${i}`] !== 1) missing.push(`k${i}`);
    }
    // Pre-fix roughly 31 of these went missing.
    expect(missing).toEqual([]);
    expect(final.sentinel).toBe("keep");
  }, 120_000);

  test("a concurrent delete does not resurrect or drop unrelated keys", async () => {
    mkdirSync(join(projectDir, ".code-shell"), { recursive: true });
    writeFileSync(
      projectSettingsPath(),
      JSON.stringify({ doomed: 1, survivor: 2 }, null, 2),
    );

    const setScript = `
      import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
      const m = new SettingsManager(${JSON.stringify(projectDir)});
      m.saveProjectSetting("added", 3, ${JSON.stringify(projectDir)});
    `;
    const delScript = `
      import { SettingsManager } from ${JSON.stringify(MANAGER_MODULE)};
      const m = new SettingsManager(${JSON.stringify(projectDir)});
      m.deleteProjectSetting("doomed", ${JSON.stringify(projectDir)});
    `;
    const procs = [
      Bun.spawn([process.execPath, "-e", setScript], { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn([process.execPath, "-e", delScript], { stdout: "pipe", stderr: "pipe" }),
    ];
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const final = readProjectSettings();
    // Whichever ran second saw the other's result, so BOTH effects survive.
    expect(final.doomed).toBeUndefined();
    expect(final.added).toBe(3);
    expect(final.survivor).toBe(2);
  }, 60_000);

  test("single-process writes still behave normally", () => {
    const m = new SettingsManager(projectDir);
    m.saveProjectSetting("alpha", "one", projectDir);
    m.saveProjectSetting("beta", "two", projectDir);
    const final = readProjectSettings();
    expect(final.alpha).toBe("one");
    expect(final.beta).toBe("two");

    m.deleteProjectSetting("alpha", projectDir);
    const afterDelete = readProjectSettings();
    expect(afterDelete.alpha).toBeUndefined();
    expect(afterDelete.beta).toBe("two");
  });
});
