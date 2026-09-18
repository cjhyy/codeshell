import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("explicit app-lifetime preapproval survives restart and Panel App updates", async () => {
    const { file, scope } = fixture();
    await new PanelAppProcessApprovalStore(file).remember(scope, { lifetime: "app" });

    const restarted = new PanelAppProcessApprovalStore(file);
    expect(await restarted.has(scope)).toBe(true);
    expect(await restarted.has({ ...scope, revision: "revision-2" })).toBe(true);
    const document = JSON.parse(readFileSync(file, "utf8"));
    expect(document.version).toBe(1);
    expect(document.approvals).toHaveLength(1);
    expect(document.approvals[0].lifetime).toBe("app");
    expect(document.approvals[0].revision).toBe(scope.revision);
  });

  test("app-lifetime grants remain bound to the app, executable path and fingerprint", async () => {
    const { file, scope } = fixture();
    const store = new PanelAppProcessApprovalStore(file);
    await store.remember(scope, { lifetime: "app" });

    for (const changed of [
      { appId: "different-app" },
      { executablePath: "/another/bin/node" },
      { executableFingerprint: "b".repeat(64) },
    ])
      expect(await store.has({ ...scope, revision: "revision-2", ...changed })).toBe(false);
  });

  test("legacy version-one approvals keep their original revision boundary", async () => {
    const { file, scope } = fixture();
    writeFileSync(file, JSON.stringify({ version: 1, approvals: [{ ...scope, approvedAt: 1 }] }), {
      mode: 0o600,
    });
    const store = new PanelAppProcessApprovalStore(file);
    expect(await store.has(scope)).toBe(true);
    expect(await store.has({ ...scope, revision: "revision-2" })).toBe(false);
    await store.remember({ ...scope, revision: "revision-2" }, { lifetime: "revision" });
    expect(await store.has(scope)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals[0].lifetime).toBeUndefined();
  });

  test("ordinary revision approvals preserve an explicit app-lifetime grant", async () => {
    const { file, scope } = fixture();
    const store = new PanelAppProcessApprovalStore(file);
    await store.remember(scope, { lifetime: "app" });
    const otherExecutable = { ...scope, executablePath: "/opt/homebrew/bin/ffmpeg" };
    await store.remember(otherExecutable);
    await store.remember({ ...otherExecutable, revision: "revision-2" });

    expect(await store.has({ ...scope, revision: "revision-3" })).toBe(true);
    expect(await store.has(otherExecutable)).toBe(false);
    expect(await store.has({ ...otherExecutable, revision: "revision-2" })).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals).toHaveLength(2);
  });

  test("extra scope properties and later mutations cannot widen or redirect approval", async () => {
    const { file, scope } = fixture();
    const store = new PanelAppProcessApprovalStore(file);
    const input = { ...scope, lifetime: "app", approvedAt: 1 };
    const pending = store.remember(input);
    input.appId = "different-app";
    input.revision = "revision-2";
    await pending;

    expect(await store.has(scope)).toBe(true);
    expect(await store.has({ ...scope, revision: "revision-2" })).toBe(false);
    expect(await store.has(input)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals[0].lifetime).toBeUndefined();
    expect(() => store.remember(scope, { lifetime: "forever" as "app" })).toThrow(
      "invalid Panel process approval lifetime",
    );
  });

  test("invalid stored lifetimes fail closed instead of widening a grant", async () => {
    const { file, scope } = fixture();
    const store = new PanelAppProcessApprovalStore(file);
    for (const lifetime of ["revision", "forever", null, 1, true]) {
      writeFileSync(
        file,
        JSON.stringify({ version: 1, approvals: [{ ...scope, lifetime, approvedAt: 1 }] }),
        { mode: 0o600 },
      );
      expect(await store.has(scope)).toBe(false);
      expect(await store.has({ ...scope, revision: "revision-2" })).toBe(false);
    }
  });

  test("concurrent app-lifetime and revision approvals both survive restart", async () => {
    const { file, scope } = fixture();
    const secondScope = { ...scope, appId: "second-app" };
    const first = new PanelAppProcessApprovalStore(file);
    const second = new PanelAppProcessApprovalStore(file);
    await Promise.all([first.remember(scope, { lifetime: "app" }), second.remember(secondScope)]);

    const restarted = new PanelAppProcessApprovalStore(file);
    expect(await restarted.has({ ...scope, revision: "revision-2" })).toBe(true);
    expect(await restarted.has(secondScope)).toBe(true);
    expect(await restarted.has({ ...secondScope, revision: "revision-2" })).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).approvals).toHaveLength(2);
  });

  test("capacity keeps an old app-lifetime grant and the latest revision grants in order", async () => {
    const { file, scope } = fixture();
    const approvals = Array.from({ length: 512 }, (_, index) => ({
      ...scope,
      appId: `app-${index}`,
      ...(index === 511 ? { lifetime: "app" } : {}),
      approvedAt: 512 - index,
    }));
    writeFileSync(file, JSON.stringify({ version: 1, approvals }), { mode: 0o600 });
    const store = new PanelAppProcessApprovalStore(file);
    const newest = { ...scope, appId: "newest-app" };
    await store.remember(newest);

    const retained = JSON.parse(readFileSync(file, "utf8")).approvals;
    expect(retained).toHaveLength(512);
    expect(retained.map((approval) => approval.appId)).toEqual([
      newest.appId,
      ...approvals.slice(0, 510).map((approval) => approval.appId),
      "app-511",
    ]);
    expect(await store.has({ ...scope, appId: "app-511", revision: "updated" })).toBe(true);
    expect(await store.has({ ...scope, appId: "app-510" })).toBe(false);
    expect(await store.has(newest)).toBe(true);
  });

  test("capacity never evicts existing app-lifetime grants and rejects a new one without writing", async () => {
    const { file, scope } = fixture();
    const approvals = Array.from({ length: 512 }, (_, index) => ({
      ...scope,
      appId: `app-${index}`,
      lifetime: "app",
      approvedAt: 512 - index,
    }));
    writeFileSync(file, JSON.stringify({ version: 1, approvals }), { mode: 0o600 });
    const store = new PanelAppProcessApprovalStore(file);
    await store.remember({ ...scope, appId: "extra-revision-app" });
    expect(JSON.parse(readFileSync(file, "utf8")).approvals).toEqual(approvals);
    const previous = readFileSync(file, "utf8");

    await expect(store.remember(scope, { lifetime: "app" })).rejects.toThrow(
      "Panel process app-lifetime approval limit exceeded",
    );
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(await store.has(scope)).toBe(false);
    expect(await store.has({ ...scope, appId: "app-511", revision: "updated" })).toBe(true);
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
