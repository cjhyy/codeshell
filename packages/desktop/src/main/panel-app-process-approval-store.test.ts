import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PanelAppProcessApprovalStore,
  type PanelProcessApprovalScope,
} from "./panel-app-process-approval-store.js";

describe("PanelAppProcessApprovalStore", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function fixture(): { file: string; scope: PanelProcessApprovalScope } {
    root = mkdtempSync(join(tmpdir(), "panel-process-approvals-"));
    return {
      file: join(root, "panel-app-process-approvals.json"),
      scope: {
        appId: "quant-lab",
        revision: "revision-1",
        executablePath: "/opt/homebrew/bin/node",
        executableFingerprint: "a".repeat(64),
      },
    };
  }

  test("persists an exact app, revision, executable, and fingerprint grant", async () => {
    const { file, scope } = fixture();
    const first = new PanelAppProcessApprovalStore(file);
    await first.remember(scope);

    const afterRestart = new PanelAppProcessApprovalStore(file);
    expect(await afterRestart.has(scope)).toBe(true);
    expect(await afterRestart.has({ ...scope, revision: "revision-2" })).toBe(false);
    expect(await afterRestart.has({ ...scope, executableFingerprint: "b".repeat(64) })).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("undefined");
  });

  test("drops grants from an older revision when a new revision is approved", async () => {
    const { file, scope } = fixture();
    const store = new PanelAppProcessApprovalStore(file);
    await store.remember(scope);
    const updated = { ...scope, revision: "revision-2" };
    await store.remember(updated);

    expect(await store.has(scope)).toBe(false);
    expect(await store.has(updated)).toBe(true);
  });

  test("fails closed on corruption and replaces it only after explicit approval", async () => {
    const { file, scope } = fixture();
    writeFileSync(file, "not-json\n", { encoding: "utf8", mode: 0o600 });
    const store = new PanelAppProcessApprovalStore(file);
    expect(await store.has(scope)).toBe(false);

    await store.remember(scope);
    expect(await new PanelAppProcessApprovalStore(file).has(scope)).toBe(true);
  });

  test("concurrent store instances preserve both approvals without waiting for a stale lock", async () => {
    const { file, scope } = fixture();
    const secondScope = { ...scope, appId: "second-app" };
    const first = new PanelAppProcessApprovalStore(file);
    const second = new PanelAppProcessApprovalStore(file);
    const startedAt = Date.now();

    await Promise.all([first.remember(scope), second.remember(secondScope)]);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const reloaded = new PanelAppProcessApprovalStore(file);
    expect(await reloaded.has(scope)).toBe(true);
    expect(await reloaded.has(secondScope)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals).toHaveLength(2);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("rejects symlink targets and retains the linked file", async () => {
    if (process.platform === "win32") return;
    const { file, scope } = fixture();
    const target = join(root, "existing.json");
    writeFileSync(target, "original contents", { mode: 0o600 });
    symlinkSync(target, file);
    const store = new PanelAppProcessApprovalStore(file);

    expect(await store.has(scope)).toBe(false);
    await expect(store.remember(scope)).rejects.toThrow("target must be a regular file");
    expect(readFileSync(target, "utf8")).toBe("original contents");
  });
});
