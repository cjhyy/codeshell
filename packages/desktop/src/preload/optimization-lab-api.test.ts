import { expect, test } from "bun:test";
import { createOptimizationLabApi } from "./optimization-lab-api";

test("lab preload has dedicated authorization and native file channels, no raw grant method", async () => {
  const calls: unknown[][] = [];
  const api = createOptimizationLabApi({
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return null;
    },
  } as any);
  const target = { projectId: "project-1" };
  await api.query("discover", { target });
  await api.authorize({
    target,
    id: "one",
    expectedRevision: 4,
    planHash: "a".repeat(64),
    expiresAt: new Date(1000).toISOString(),
    operationId: "native",
    limits: { maxRequests: 12, maxExecutionMs: 60000 },
  });
  await api.exportFile({ target, id: "one", kind: "grading" });
  await api.importGrading({ target, id: "one", expectedRevision: 4 });
  await api.importDataset({ target });
  await api.exportDataset({ target, text: '{\n  "cases": []\n}\n' });
  expect(calls.map((call) => call[0])).toEqual([
    "optimizationLab:query",
    "optimizationLab:authorize",
    "optimizationLab:exportFile",
    "optimizationLab:importGrading",
    "optimizationLab:importDataset",
    "optimizationLab:exportDataset",
  ]);
  expect(calls[4]).toEqual(["optimizationLab:importDataset", { target }]);
  expect(calls[5]).toEqual([
    "optimizationLab:exportDataset",
    { target, text: '{\n  "cases": []\n}\n' },
  ]);
  expect("grant" in api).toBe(false);
});
