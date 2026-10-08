import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { OptimizationLabPage, type LabSnapshot } from "./OptimizationLabPage";
import { datasetDrafts } from "./dataset-drafts";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
}
describe("Optimization Lab manual Desktop workflow", () => {
  let root: Root, container: HTMLElement, previous: PropertyDescriptor | undefined;
  let calls: Array<{ type: string; input: any }>,
    authorizations: any[],
    accepted: boolean,
    enabled: boolean;
  let snapshot: LabSnapshot;
  let imported: string | null;
  let importPromise: Promise<string | null> | undefined;
  let validationPromise: Promise<any> | undefined;
  let exports: Array<{ target: { projectId: string }; text: string }>;
  let evidenceCalls: string[];
  let adoptions: any[];
  let reportEligible: boolean;
  const find = (id: string) =>
    descendants(container).find((node) => props(node)["data-testid"] === `optimization-lab-${id}`)!;
  const click = async (id: string) => {
    await act(async () => {
      props(find(id)).onClick();
      await flushMicrotasks();
    });
  };
  beforeEach(async () => {
    ensureMiniDom();
    datasetDrafts.clear();
    imported = null;
    importPromise = undefined;
    validationPromise = undefined;
    exports = [];
    evidenceCalls = [];
    adoptions = [];
    reportEligible = false;
    calls = [];
    authorizations = [];
    accepted = false;
    enabled = true;
    snapshot = {
      id: "experiment-1",
      state: { revision: 4, status: "ready" },
      plan: {
        planHash: "a".repeat(64),
        skill: { name: "summarize" },
        bounds: { trial: { maxOutputTokens: 100 }, maxCandidates: 1 },
        connections: {
          target: { modelId: "text-model", connectionId: "model-1" },
          optimizer: { modelId: "text-model", connectionId: "model-1" },
        },
      },
      estimate: { maxRequests: 20, maxExecutionMs: 120000 },
      datasetSummary: { dev: 3, holdout: 3, sourceGroups: 6 },
    };
    previous = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        getSettings: async () => ({ featureFlags: { optimization_lab: enabled } }),
        optimizationLab: {
          adopt: async (input: any) => {
            adoptions.push(input);
            return null;
          },
          previewEvidence: async () => {
            evidenceCalls.push("preview");
            return {
              previewId: "preview",
              bundle: {
                bundleHash: "e".repeat(64),
                runs: [
                  {
                    runId: "selected",
                    blocks: [],
                    missingEvidence: ["historical snapshot missing"],
                  },
                ],
              },
            };
          },
          importEvidence: async () => {
            evidenceCalls.push("confirm");
            return accepted
              ? {
                  cases: [
                    {
                      id: "evidence-selected",
                      version: 1,
                      sourceGroupId: "selected",
                      provenance: "real",
                      caseRole: "target_failure",
                      split: "dev",
                      input: "Reviewed input",
                      readiness: "analysis_only",
                      missingEvidence: ["confirm criteria"],
                      evidence: {
                        bundleHash: "e".repeat(64),
                        runId: "selected",
                        purpose: "problem_source_only",
                        blockHashes: [],
                      },
                    },
                  ],
                }
              : null;
          },
          query: async (type: string, input: any) => {
            calls.push({ type, input });
            if (type === "discover")
              return {
                skills: [{ name: "summarize", source: "project" }],
                connections: [
                  {
                    id: "model-1",
                    label: "Local fake",
                    model: "text-model",
                    provider: "openai",
                    eligible: true,
                  },
                ],
              };
            if (type === "list" || type === "bindings") return [];
            if (type === "report")
              return {
                hash: "d".repeat(64),
                markdown: "Fixture report",
                json: { adoptionEligible: reportEligible },
              };
            if (type === "validate_dataset")
              return validationPromise ?? { ok: true, issues: [], summary: { dev: 3, holdout: 3 } };
            if (type === "freeze_dataset") return { datasetHash: "b".repeat(64) };
            if (type === "start")
              snapshot = {
                ...snapshot,
                state: { ...snapshot.state, revision: 6, status: "awaiting_baseline_grading" },
              };
            return structuredClone(snapshot);
          },
          authorize: async (input: any) => {
            authorizations.push(input);
            if (!accepted) return null;
            snapshot = {
              ...snapshot,
              grant: {
                revision: 1,
                startOperationId: "native-start-1",
                maxRequests: 20,
                maxExecutionMs: 120000,
              },
              state: { ...snapshot.state, revision: 5, status: "authorized" },
            };
            return structuredClone(snapshot);
          },
          exportFile: async () => true,
          importGrading: async () => structuredClone(snapshot),
          importDataset: async () => importPromise ?? imported,
          exportDataset: async (input: any) => {
            exports.push(input);
            return true;
          },
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    if (previous) Object.defineProperty(window, "codeshell", previous);
    else delete (window as any).codeshell;
  });
  async function mount(project: string | null = "project-1") {
    await act(async () => {
      root.render(<OptimizationLabPage activeProjectId={project} />);
      await flushMicrotasks();
    });
  }
  test("flag off and no project never access the worker", async () => {
    enabled = false;
    await mount();
    expect(calls).toHaveLength(0);
    enabled = true;
    await mount(null);
    expect(calls).toHaveLength(0);
  });
  test("evidence preview and native cancellation do not edit cases or authorize spending", async () => {
    await mount();
    await act(async () => {
      props(find("evidence-ids")).onChange({ target: { value: "selected" } });
      await flushMicrotasks();
    });
    await click("preview-evidence");
    expect(find("evidence-preview")).toBeDefined();
    await click("import-evidence");
    expect(evidenceCalls).toEqual(["preview", "confirm"]);
    expect(authorizations).toHaveLength(0);
    expect(calls.map((call) => call.type)).toEqual(["discover", "list", "bindings"]);
    accepted = true;
    await click("import-evidence");
    await click("dataset-json");
    const draft = JSON.parse(props(find("dataset")).value);
    expect(draft.cases.at(-1)).toMatchObject({
      provenance: "real",
      readiness: "analysis_only",
      evidence: { runId: "selected" },
    });
    expect(draft.cases.at(-1).expected).toBeUndefined();
    expect(calls.some((call) => call.type === "start")).toBe(false);
  });
  test("fixed candidate selection freezes source identity and uses a separate prepare_trial authorization", async () => {
    snapshot.state = { revision: 10, status: "report_ready", data: { reportRef: "report" } };
    snapshot.candidates = [
      {
        hash: "c".repeat(64),
        bodyHash: "d".repeat(64),
        body: "Fixed instructions",
        explanation: "Earlier proposal",
      },
    ];
    await mount();
    await click("prepare");
    await click("try-candidate");
    expect(find("trial-source")).toBeDefined();
    await click("prepare");
    const prepared = calls.find((call) => call.type === "prepare_trial")!;
    expect(prepared.input).toMatchObject({
      sourceExperimentId: "experiment-1",
      candidateHash: "c".repeat(64),
    });
    expect(prepared.input.targetConnectionId).toBeUndefined();
    expect(prepared.input.optimizerConnectionId).toBeUndefined();
    await click("authorize");
    expect(authorizations).toHaveLength(1);
    expect(calls.some((call) => call.type === "start")).toBe(false);
  });
  test("isolated execution freezes its mode and eligible adoption chooses an explicit native Session scope", async () => {
    reportEligible = true;
    snapshot.state = { ...snapshot.state, status: "report_ready", data: { reportRef: "report" } };
    await mount();
    await act(async () => {
      props(find("execution-mode")).onChange({ target: { value: "codeshell_isolated" } });
      await flushMicrotasks();
    });
    await click("prepare");
    expect(calls.find((call) => call.type === "prepare")?.input.executionMode).toBe(
      "codeshell_isolated",
    );
    await click("open-report");
    await act(async () => {
      props(find("adoption-scope")).onChange({ target: { value: "session" } });
      await flushMicrotasks();
    });
    expect(props(find("adopt")).disabled).toBe(true);
    await act(async () => {
      props(find("adoption-session")).onChange({ target: { value: "ordinary-session" } });
      await flushMicrotasks();
    });
    await click("adopt");
    expect(adoptions).toEqual([
      {
        target: { projectId: "project-1" },
        id: snapshot.id,
        reportHash: "d".repeat(64),
        scope: { kind: "session", sessionId: "ordinary-session" },
      },
    ]);
    expect(calls.some((call) => call.type === "adopt" || call.type === "start")).toBe(false);
  });
  test("dataset freeze and preparing are offline; native cancel never starts", async () => {
    await mount();
    await click("validate");
    await click("prepare");
    expect(calls.map((call) => call.type)).toEqual([
      "discover",
      "list",
      "bindings",
      "validate_dataset",
      "freeze_dataset",
      "prepare",
      "list",
    ]);
    expect(props(find("start")).disabled).toBe(true);
    await click("authorize");
    expect(authorizations[0]).toMatchObject({
      target: { projectId: "project-1" },
      id: snapshot.id,
      planHash: snapshot.plan.planHash,
      expectedRevision: 4,
      limits: { maxRequests: 20, maxExecutionMs: 120000 },
    });
    expect(typeof authorizations[0].expiresAt).toBe("string");
    expect(calls.some((call) => call.type === "start")).toBe(false);
    expect(props(find("start")).disabled).toBe(true);
  });
  test("explicit start binds native operation and exact revision; grading import never continues", async () => {
    await mount();
    await click("prepare");
    accepted = true;
    await click("authorize");
    expect(calls.some((call) => call.type === "start")).toBe(false);
    expect(props(find("start")).disabled).toBe(false);
    await click("start");
    expect(calls.find((call) => call.type === "start")?.input).toMatchObject({
      id: "experiment-1",
      expectedRevision: 5,
      operationId: "native-start-1",
    });
    expect(props(find("continue")).disabled).toBe(false);
    await click("import-grading");
    expect(calls.some((call) => call.type === "continue")).toBe(false);
    await click("continue");
    expect(calls.find((call) => call.type === "continue")?.input.expectedRevision).toBe(6);
  });
  test("imports retain raw drafts per project; export preserves invalid JSON without queries", async () => {
    await mount("project-a");
    imported = "{broken JSON for repair";
    await click("import-dataset");
    await click("export-dataset");
    expect(exports.at(-1)).toEqual({ target: { projectId: "project-a" }, text: imported });
    expect(datasetDrafts.get("project-a")).toBe(imported);
    await mount("project-b");
    await click("export-dataset");
    expect(exports.at(-1)?.text).not.toBe(imported);
    await mount("project-a");
    await click("export-dataset");
    expect(exports.at(-1)?.text).toBe(imported);
    expect(calls.every((call) => ["discover", "list", "bindings"].includes(call.type))).toBe(true);
  });
  test("cancelled import keeps the draft; late import cannot populate another project", async () => {
    datasetDrafts.set("project-a", "original draft");
    await mount("project-a");
    await click("import-dataset");
    expect(datasetDrafts.get("project-a")).toBe("original draft");
    let finish!: (text: string) => void;
    importPromise = new Promise((resolve) => {
      finish = resolve;
    });
    await click("import-dataset");
    await mount("project-b");
    await act(async () => {
      finish("late private A material");
      await flushMicrotasks();
    });
    await click("export-dataset");
    expect(exports.at(-1)?.target.projectId).toBe("project-b");
    expect(exports.at(-1)?.text).not.toContain("private A");
    expect(datasetDrafts.get("project-a")).toBe("original draft");
    expect(datasetDrafts.has("project-b")).toBe(false);
  });
  test("project switch discards late dataset validation and never freezes into the new project", async () => {
    let finish!: (value: any) => void;
    validationPromise = new Promise((resolve) => {
      finish = resolve;
    });
    await mount("project-a");
    await click("validate");
    await mount("project-b");
    await act(async () => {
      finish({ ok: true });
      await flushMicrotasks();
    });
    expect(calls.some((call) => call.type === "freeze_dataset")).toBe(false);
    expect(find("validation")).toBeUndefined();
  });
});
