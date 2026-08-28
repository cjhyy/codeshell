import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
