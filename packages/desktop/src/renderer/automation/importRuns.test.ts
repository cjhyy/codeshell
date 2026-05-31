import { describe, it, expect } from "bun:test";
import { importAutomationRuns, type ImportableRun, type ImportDeps } from "./importRuns";
import type { FoldItem } from "../../preload/types";

const repos = [{ id: "r1", name: "alpha", path: "/repo/alpha" }];

function run(over: Partial<ImportableRun>): ImportableRun {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    cwd: "/repo/alpha",
    objective: "do a thing",
    status: "completed",
    finishedAt: 1000,
    createdAt: 900,
    source: "automation",
    cronJobName: "nightly",
    ...over,
  };
}

function deps(over: Partial<ImportDeps> = {}): { d: ImportDeps; imported: Array<{ repoId: string | null; sessionId: string }> } {
  const imported: Array<{ repoId: string | null; sessionId: string; runStatus?: string }> = [];
  const d: ImportDeps = {
    caseInsensitive: false,
    existingEngineSessionIds: new Set<string>(),
    fetchTranscript: async (): Promise<FoldItem[]> => [{ kind: "user", text: "hi" }],
    writeImported: (repoId, summary, _state) => { imported.push({ repoId, sessionId: summary.id, runStatus: summary.runStatus }); },
    createRepoForCwd: () => "auto-repo",
    cap: 50,
    ...over,
  };
  return { d, imported };
}

describe("importAutomationRuns", () => {
  it("imports a completed automation run into its repo", async () => {
    const { d, imported } = deps();
    await importAutomationRuns([run({})], repos, d);
    expect(imported).toHaveLength(1);
    expect(imported[0].repoId).toBe("r1");
  });

  it("skips runs that are not automation-sourced", async () => {
    const { d, imported } = deps();
    await importAutomationRuns([run({ source: undefined })], repos, d);
    expect(imported).toHaveLength(0);
  });

  it("skips only session-less runs (running-with-sessionId now imports)", async () => {
    const { d, imported } = deps();
    await importAutomationRuns(
      [run({ runId: "r2", sessionId: null, status: "queued", finishedAt: null })],
      repos,
      d,
    );
    expect(imported).toHaveLength(0);
  });

  it("imports a running automation run (no terminal filter) and carries runStatus", async () => {
    const { d, imported } = deps();
    await importAutomationRuns(
      [run({ runId: "live", sessionId: "sess-live", status: "running", finishedAt: null })],
      repos,
      d,
    );
    expect(imported).toHaveLength(1);
    expect(imported[0].runStatus).toBe("running");
  });

  it("carries terminal runStatus too", async () => {
    const { d, imported } = deps();
    await importAutomationRuns([run({ status: "completed" })], repos, d);
    expect(imported[0].runStatus).toBe("completed");
  });

  it("dedups against already-known engineSessionIds", async () => {
    const { d, imported } = deps({ existingEngineSessionIds: new Set(["sess-1"]) });
    await importAutomationRuns([run({})], repos, d);
    expect(imported).toHaveLength(0);
  });

  it("auto-creates a repo when cwd matches none", async () => {
    let createdFor = "";
    const { d, imported } = deps({ createRepoForCwd: (cwd) => { createdFor = cwd; return "new-repo"; } });
    await importAutomationRuns([run({ cwd: "/somewhere/new" })], repos, d);
    expect(createdFor).toBe("/somewhere/new");
    expect(imported[0].repoId).toBe("new-repo");
  });

  it("caps to the N most-recent per repo", async () => {
    const runs: ImportableRun[] = [];
    for (let i = 0; i < 60; i++) runs.push(run({ runId: `run-${i}`, sessionId: `sess-${i}`, finishedAt: i }));
    const { d, imported } = deps({ cap: 50 });
    await importAutomationRuns(runs, repos, d);
    expect(imported).toHaveLength(50);
    const ids = new Set(imported.map((x) => x.sessionId));
    expect(ids.has("sess-59")).toBe(true);
    expect(ids.has("sess-0")).toBe(false);
  });

  it("does not throw when a transcript fetch fails", async () => {
    const { d, imported } = deps({ fetchTranscript: async () => { throw new Error("io"); } });
    await importAutomationRuns([run({})], repos, d);
    expect(imported).toHaveLength(1);
  });

  it("creates only ONE repo for multiple runs sharing an unmatched cwd", async () => {
    let createCalls = 0;
    const { d, imported } = deps({
      createRepoForCwd: () => { createCalls += 1; return "auto-1"; },
    });
    await importAutomationRuns(
      [
        run({ runId: "a", sessionId: "sess-a", cwd: "/new/path" }),
        run({ runId: "b", sessionId: "sess-b", cwd: "/new/path" }),
        run({ runId: "c", sessionId: "sess-c", cwd: "/new/path/" }), // trailing slash → same after normalize
      ],
      repos,
      d,
    );
    expect(createCalls).toBe(1);
    expect(imported).toHaveLength(3);
    expect(new Set(imported.map((x) => x.repoId))).toEqual(new Set(["auto-1"]));
  });
});
