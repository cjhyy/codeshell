import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { OptimizationLabPage, type LabSnapshot } from "./OptimizationLabPage";

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
            if (type === "list") return [];
            if (type === "validate_dataset") return { ok: true, summary: { dev: 3, holdout: 3 } };
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
  test("dataset freeze and preparing are offline; native cancel never starts", async () => {
    await mount();
    await click("validate");
    await click("prepare");
    expect(calls.map((call) => call.type)).toEqual([
      "discover",
      "list",
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
});
