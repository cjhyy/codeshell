import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "./manager.js";

// A settings mutation reads the file, changes one key, and writes the whole
// object back. That read MUST distinguish "absent" (start from {}) from
// "present but unsafe to read" (malformed / oversize / unreadable). Folding
// both to {} means a corrupt or too-large file is silently replaced by an
// object holding only the new key — the rest of the user's settings are gone,
// and the call reports success.
//
// The tolerant behaviour of ordinary LOADS is deliberate and stays: a corrupt
// layer is skipped so the app still starts (yaml-config.test.ts pins that).
// Only the read-modify-write path is strict.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(prefix: string): { cwd: string; settingsPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  return { cwd, settingsPath: join(cwd, ".code-shell", "settings.json") };
}

describe("SettingsManager.saveProjectSetting — fail closed on an unreadable file", () => {
  test("refuses to overwrite malformed JSON and leaves the bytes untouched", () => {
    const { cwd, settingsPath } = project("cs-mutate-malformed-");
    const original = '{"keep":"me", BROKEN';
    writeFileSync(settingsPath, original);

    expect(() =>
      new SettingsManager(cwd, "project").saveProjectSetting("newKey", "v", cwd),
    ).toThrow(/could not be read|malformed|invalid/i);

    expect(readFileSync(settingsPath, "utf-8")).toBe(original);
  });

  test("refuses to overwrite an oversize file and leaves the bytes untouched", () => {
    const { cwd, settingsPath } = project("cs-mutate-oversize-");
    // Valid JSON, but past the 4 MiB bound the reader enforces.
    const original = JSON.stringify({ keep: "me", pad: "x".repeat(5 * 1024 * 1024) });
    writeFileSync(settingsPath, original);
    const beforeSize = statSync(settingsPath).size;

    expect(() =>
      new SettingsManager(cwd, "project").saveProjectSetting("newKey", "v", cwd),
    ).toThrow(/could not be read|too large|exceeds/i);

    expect(statSync(settingsPath).size).toBe(beforeSize);
    expect(readFileSync(settingsPath, "utf-8")).toBe(original);
  });

  test("an absent file still starts from an empty object", () => {
    const { cwd, settingsPath } = project("cs-mutate-absent-");
    // No settings.json at all — the normal first-write path.
    new SettingsManager(cwd, "project").saveProjectSetting("newKey", "v", cwd);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ newKey: "v" });
  });

  test("a valid file is still merged, not replaced", () => {
    const { cwd, settingsPath } = project("cs-mutate-valid-");
    writeFileSync(settingsPath, JSON.stringify({ keep: "me" }, null, 2));

    new SettingsManager(cwd, "project").saveProjectSetting("newKey", "v", cwd);

    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      keep: "me",
      newKey: "v",
    });
  });

  test("a YAML-only project still folds into JSON rather than failing", () => {
    const { cwd, settingsPath } = project("cs-mutate-yaml-");
    writeFileSync(join(cwd, ".code-shell", "settings.yaml"), "existingKey: keepme\n");

    new SettingsManager(cwd, "project").saveProjectSetting("newKey", "v", cwd);

    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      existingKey: "keepme",
      newKey: "v",
    });
  });

  test("malformed YAML is refused rather than silently dropped", () => {
    const { cwd } = project("cs-mutate-badyaml-");
    const yamlPath = join(cwd, ".code-shell", "settings.yaml");
    const original = "existingKey: [unclosed\n  bad: : :\n";
    writeFileSync(yamlPath, original);

    expect(() =>
      new SettingsManager(cwd, "project").saveProjectSetting("newKey", "v", cwd),
    ).toThrow(/could not be read|malformed|invalid/i);

    expect(readFileSync(yamlPath, "utf-8")).toBe(original);
  });

  test("ordinary loads stay tolerant of a corrupt layer", () => {
    const { cwd, settingsPath } = project("cs-load-tolerant-");
    writeFileSync(settingsPath, '{"keep":"me", BROKEN');

    // Reading must NOT throw — a corrupt layer is skipped so the app boots.
    expect(() => new SettingsManager(cwd, "project").get()).not.toThrow();
  });
});
