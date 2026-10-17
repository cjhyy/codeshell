import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canCleanupPackagedProcesses } from "./packaged-process-exits.mjs";

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), "packaged-exits-test-"));
  const state = {
    home,
    launchFailed: false,
    children: [{ pid: 101, exitCode: 0, signalCode: null }],
    verifiedMains: new Set([101]),
    verifiedWorkerMains: new Set(),
    workers: new Set(),
  };
  const put = (name, rows) =>
    writeFile(join(home, name), rows.map(JSON.stringify).join("\n") + "\n");
  try {
    await run(state, put);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("only explicit UI mode accepts absent worker logs with a guarded Main zero-spawn exit", () =>
  fixture(async (state, put) => {
    await put("main-exits.jsonl", [{ pid: 101, workerSpawnCount: 0 }]);
    await expect(canCleanupPackagedProcesses(state)).rejects.toThrow();
    expect(await canCleanupPackagedProcesses({ ...state, requireWorkerEvidence: false })).toBe(
      true,
    );
  }));

test("UI mode retains HOME after forced Main termination or a missing/corrupt spawn proof", () =>
  fixture(async (state, put) => {
    const ui = { ...state, requireWorkerEvidence: false };
    await expect(canCleanupPackagedProcesses(ui)).rejects.toThrow();
    await put("main-exits.jsonl", [{ pid: 101, workerSpawnCount: 1 }]);
    expect(await canCleanupPackagedProcesses(ui)).toBe(false);
    await writeFile(join(state.home, "main-exits.jsonl"), "{broken");
    await expect(canCleanupPackagedProcesses(ui)).rejects.toThrow();
  }));

test("UI mode requires exit receipts for every actual worker and rejects removed spawn logs", () =>
  fixture(async (state, put) => {
    const ui = { ...state, requireWorkerEvidence: false };
    state.verifiedWorkerMains.add(101);
    state.workers.add(102);
    await put("main-exits.jsonl", [{ pid: 101, workerSpawnCount: 1 }]);
    await put("spawned-workers.jsonl", [{ pid: 102, mainPid: 101 }]);
    expect(await canCleanupPackagedProcesses(ui)).toBe(false);
    await put("worker-exits.jsonl", [{ pid: 102, code: 0, signal: null }]);
    expect(await canCleanupPackagedProcesses(ui)).toBe(true);
    await rm(join(state.home, "spawned-workers.jsonl"));
    expect(await canCleanupPackagedProcesses(ui)).toBe(false);
  }));

test("default Pet mode still requires verified workers for every Main generation", () =>
  fixture(async (state, put) => {
    state.workers.add(102);
    await put("spawned-workers.jsonl", [{ pid: 102, mainPid: 101 }]);
    await put("worker-exits.jsonl", [{ pid: 102, code: 0, signal: null }]);
    expect(await canCleanupPackagedProcesses(state)).toBe(false);
    state.verifiedWorkerMains.add(101);
    expect(await canCleanupPackagedProcesses(state)).toBe(true);
    state.children.push({ pid: 201, exitCode: 0, signalCode: null });
    state.verifiedMains.add(201);
    expect(await canCleanupPackagedProcesses(state)).toBe(false);
  }));

test("no mode removes HOME for a live, unverified or failed Main launch", () =>
  fixture(async (state, put) => {
    await put("main-exits.jsonl", [{ pid: 101, workerSpawnCount: 0 }]);
    const ui = { ...state, requireWorkerEvidence: false };
    for (const override of [
      { children: [] },
      { launchFailed: true },
      { verifiedMains: new Set() },
      { children: [{ pid: 101, exitCode: null, signalCode: null }] },
    ])
      expect(await canCleanupPackagedProcesses({ ...ui, ...override })).toBe(false);
  }));

test("UI mode requires every Main generation to have exactly one zero-spawn exit receipt", () =>
  fixture(async (state, put) => {
    state.children.push({ pid: 201, exitCode: 0, signalCode: null });
    state.verifiedMains.add(201);
    const ui = { ...state, requireWorkerEvidence: false };
    const first = { pid: 101, workerSpawnCount: 0 };
    await put("main-exits.jsonl", [first]);
    expect(await canCleanupPackagedProcesses(ui)).toBe(false);
    await put("main-exits.jsonl", [first, first, { pid: 201, workerSpawnCount: 0 }]);
    expect(await canCleanupPackagedProcesses(ui)).toBe(false);
    await put("main-exits.jsonl", [first, { pid: 201, workerSpawnCount: 0 }]);
    expect(await canCleanupPackagedProcesses(ui)).toBe(true);
  }));

test("a syntactically valid but incomplete worker exit record cannot permit cleanup", () =>
  fixture(async (state, put) => {
    state.workers.add(102);
    state.verifiedWorkerMains.add(101);
    await put("spawned-workers.jsonl", [{ pid: 102, mainPid: 101 }]);
    await put("worker-exits.jsonl", [{ pid: 102, code: null, signal: null }]);
    expect(await canCleanupPackagedProcesses(state)).toBe(false);
    await put("main-exits.jsonl", [{ pid: 101, workerSpawnCount: 1 }]);
    expect(await canCleanupPackagedProcesses({ ...state, requireWorkerEvidence: false })).toBe(
      false,
    );
  }));
