import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOptimizationLabIpc } from "./optimization-lab-ipc";
import { isOptimizationLabQuery } from "../shared/optimization-lab";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = "a".repeat(64);
function setup() {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const sender = { id: 1, mainFrame: {} };
  const window = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: sender.mainFrame };
  const calls: Array<{ type: string; params: any }> = [];
  let enabled = true,
    trusted = true,
    confirmed = 1;
  let selectedFile: string | undefined;
  let confirming: (() => void) | undefined;
  const snapshot = {
    id: "experiment-1",
    state: { revision: 7, status: "ready" },
    plan: {
      planHash: hash,
      targetConnection: { model: "target" },
      optimizerConnection: { model: "optimizer" },
      externalDataRoles: ["task", "optimizer"],
    },
  };
  const dialogs: any[] = [];
  const dispose = registerOptimizationLabIpc({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler as any),
      removeHandler: (channel) => handlers.delete(channel),
    } as any,
    windows: () => [window] as any,
    enabled: () => enabled,
    resolveTarget: async (target) => {
      if (JSON.stringify(target) !== JSON.stringify({ projectId: "project" }))
        throw new Error("stable project identity required");
      return { kind: "project", cwd: "/authoritative/primary" };
    },
    trusted: async () => trusted,
    query: async (type, params) => {
      calls.push({ type, params });
      if (type.endsWith("get")) return structuredClone(snapshot);
      if (type.endsWith("discover")) return { connections: [] };
      if (type.endsWith("report"))
        return { hash, json: { verified: false }, markdown: "# Immutable report" };
      return snapshot;
    },
    skills: () => [{ name: "example", source: "project" }],
    confirm: async (_window, options) => {
      dialogs.push(options);
      confirming?.();
      return { response: confirmed };
    },
    save: async () => selectedFile,
    choose: async () => selectedFile,
  });
  const authorization = {
    target: { projectId: "project" },
    id: snapshot.id,
    planHash: hash,
    expectedRevision: 7,
    operationId: "confirmation-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    limits: {
      maxRequests: 20,
      maxExecutionMs: 120_000,
      maxEstimatedTokens: null,
      maxEstimatedCostUsd: null,
    },
  };
  return {
    handlers,
    event,
    calls,
    dialogs,
    snapshot,
    authorization,
    dispose,
    enable: (on: boolean) => {
      enabled = on;
    },
    trust: (on: boolean) => {
      trusted = on;
    },
    confirm: (result: number) => {
      confirmed = result;
    },
    duringConfirmation: (action: () => void) => {
      confirming = action;
    },
    select: (file: string) => {
      selectedFile = file;
    },
    invoke: (channel: string, ...args: any[]) =>
      handlers.get(`optimizationLab:${channel}`)!(event as any, ...args),
  };
}

describe("Optimization Lab trusted Desktop bridge", () => {
  test("rejects non-top-frame, flag-off, arbitrary paths and untrusted projects before worker access", async () => {
    const fixture = setup();
    const handler = fixture.handlers.get("optimizationLab:query")!;
    expect(() =>
      handler({ ...fixture.event, senderFrame: {} }, "discover", {
        target: { projectId: "project" },
      }),
    ).toThrow("top frame");
    fixture.enable(false);
    expect(() => fixture.invoke("query", "discover", { target: { projectId: "project" } })).toThrow(
      "disabled",
    );
    fixture.enable(true);
    await expect(
      fixture.invoke("query", "discover", { target: { projectId: "project" }, cwd: "/evil" }),
    ).rejects.toThrow("cwd");
    await expect(fixture.invoke("query", "discover", { target: { cwd: "/evil" } })).rejects.toThrow(
      "stable",
    );
    fixture.trust(false);
    await expect(
      fixture.invoke("query", "discover", { target: { projectId: "project" } }),
    ).rejects.toThrow("trusted");
    expect(fixture.calls).toHaveLength(0);
  });
  test("only allowlisted queries can cross and discovery merges Main-owned skill catalog", async () => {
    const fixture = setup();
    for (const type of ["grant", "optimization_lab_grant", "unknown"])
      await expect(
        fixture.invoke("query", type, { target: { projectId: "project" } }),
      ).rejects.toThrow("Unsupported");
    expect(fixture.calls).toHaveLength(0);
    expect(await fixture.invoke("query", "discover", { target: { projectId: "project" } })).toEqual(
      { connections: [], skills: [{ name: "example", source: "project" }] },
    );
    expect(fixture.calls[0]).toEqual({
      type: "optimization_lab_discover",
      params: { cwd: "/authoritative/primary" },
    });
  });
  test("cancelled native confirmation never grants or starts; renderer confirmation booleans are rejected", async () => {
    const fixture = setup();
    fixture.confirm(0);
    expect(await fixture.invoke("authorize", fixture.authorization)).toBeNull();
    expect(fixture.calls.map((call) => call.type)).toEqual(["optimization_lab_get"]);
    expect(fixture.dialogs[0].detail).toContain(hash);
    expect(fixture.dialogs[0].detail).toContain("unknown");
    await expect(
      fixture.invoke("authorize", { ...fixture.authorization, confirmed: true }),
    ).rejects.toThrow("confirmed");
  });
  test("native confirmation binds hash and revision and grants without starting", async () => {
    const fixture = setup();
    await fixture.invoke("authorize", fixture.authorization);
    expect(fixture.calls.map((call) => call.type)).toEqual([
      "optimization_lab_get",
      "optimization_lab_get",
      "optimization_lab_grant",
    ]);
    expect(fixture.calls[2].params).toEqual({
      ...Object.fromEntries(
        Object.entries(fixture.authorization).filter(([key]) => key !== "target"),
      ),
      cwd: "/authoritative/primary",
    });
  });
  test("concurrent state changes or disabling while confirmation is open invalidates approval", async () => {
    const changed = setup();
    changed.duringConfirmation(() => {
      changed.snapshot.state.revision++;
    });
    await expect(changed.invoke("authorize", changed.authorization)).rejects.toThrow("changed");
    expect(changed.calls.every((call) => call.type !== "optimization_lab_grant")).toBe(true);
    const disabled = setup();
    disabled.duringConfirmation(() => disabled.enable(false));
    await expect(disabled.invoke("authorize", disabled.authorization)).rejects.toThrow("no longer");
    expect(disabled.calls.every((call) => call.type !== "optimization_lab_grant")).toBe(true);
  });
  test("grading imports use native file selection, reject symlinks and preserve exact revision", async () => {
    const fixture = setup();
    const root = await mkdtemp(join(tmpdir(), "lab-ipc-"));
    roots.push(root);
    const path = join(root, "grades.json");
    await writeFile(path, JSON.stringify({ reviewer: "human", items: [] }));
    const link = join(root, "linked.json");
    await symlink(path, link);
    fixture.select(link);
    await expect(
      fixture.invoke("importGrading", {
        target: { projectId: "project" },
        id: "experiment-1",
        expectedRevision: 7,
      }),
    ).rejects.toThrow();
    expect(fixture.calls).toHaveLength(0);
    fixture.select(path);
    await fixture.invoke("importGrading", {
      target: { projectId: "project" },
      id: "experiment-1",
      expectedRevision: 7,
    });
    expect(fixture.calls).toEqual([
      {
        type: "optimization_lab_import_grading",
        params: {
          cwd: "/authoritative/primary",
          id: "experiment-1",
          expectedRevision: 7,
          grading: { reviewer: "human", items: [] },
        },
      },
    ]);
  });
  test("generic RPC guard covers every lab operation, while ordinary queries remain unchanged", () => {
    for (const type of ["grant", "start", "prepare", "report"])
      expect(
        isOptimizationLabQuery({
          method: "agent/query",
          params: { type: `optimization_lab_${type}` },
        }),
      ).toBe(true);
    expect(isOptimizationLabQuery({ method: "agent/query", params: { type: "goalGet" } })).toBe(
      false,
    );
    expect(
      isOptimizationLabQuery({ method: "agent/run", params: { type: "optimization_lab_grant" } }),
    ).toBe(false);
  });
});
