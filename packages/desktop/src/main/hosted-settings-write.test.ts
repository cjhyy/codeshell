import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import { settingsChange, validateRendererSettingsPatch } from "./renderer-settings-edits.js";
import { writeSettings } from "./settings-service.js";

test("withdrawn settings writes leave the original file in place under the storage lock", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "codeshell-settings-permit-"));
  const dir = join(cwd, ".code-shell"),
    file = join(dir, "settings.json");
  try {
    await mkdir(dir);
    await writeFile(file, "invalid existing document");
    const permit = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(permit, 0, -1);
    await expect(
      writeSettings("project", { feature: true }, cwd, () => claimBusinessCommit(permit)),
    ).rejects.toThrow("revoked");
    expect(await readFile(file, "utf8")).toBe("invalid existing document");
    await writeFile(file, "{}");
    Atomics.store(permit, 0, 0);
    await writeSettings("project", { feature: true }, cwd, () => claimBusinessCommit(permit));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ feature: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("settings refresh receipts carry only required native projections", () => {
  expect(
    settingsChange("user", {
      git: { foo: "sensitive" },
      pet: { showExternalCodexSessions: true },
      apiKey: "private",
    }),
  ).toEqual({
    git: true,
    pet: true,
    externalVisibility: true,
    pluginCommands: false,
    panelApps: false,
  });
  expect(() => validateRendererSettingsPatch({ panelAppOverrides: {} })).toThrow(
    "reviewed project binding",
  );
});
