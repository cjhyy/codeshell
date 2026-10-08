import { afterEach, expect } from "bun:test";
import { isolatedBackendTest } from "../test-utils/backend-test.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OptimizationLabController } from "./controller.js";
import type { LabSettings } from "./providers/connection.js";
const test = isolatedBackendTest(import.meta.path);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(
  options: {
    human?: boolean;
    maxRequests?: number;
    upstream?: typeof fetch;
    regression?: boolean;
    semanticRegression?: boolean;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "lab-engine-"));
  roots.push(cwd);
  const skillDir = join(cwd, ".agents", "skills", "lab-test");
  mkdirSync(skillDir, { recursive: true });
  const skill =
    "---\nname: lab-test\ndescription: Standalone text test\n---\nSummarize the current source.\n";
  writeFileSync(join(skillDir, "SKILL.md"), skill);
  const dataset = {
    schemaVersion: 1,
    title: "Sourcing",
    taskFamily: "sourcing",
    cases: Array.from({ length: 6 }, (_, i) => ({
      id: `${i < 3 ? "dev" : "hold"}-${i}`,
      version: 1,
      sourceGroupId: `source-${i}`,
      provenance: "synthetic",
      caseRole: i === 0 ? "regression" : "target_failure",
      split: i < 3 ? "dev" : "holdout",
      input: `Summarize source ${i}.`,
      hardAssertions: options.semanticRegression
        ? []
        : [{ id: "cites", kind: "contains", value: "[S1]" }],
      rubric: options.human
        ? [{ id: "clear", text: "Answer addresses the current source", requiresHumanGrading: true }]
        : [],
      readiness: "runnable",
    })),
  };
  const settings = {
    credentials: [
      {
        id: "lab-key",
        catalogId: "openai",
        apiKey: "fake-secret",
        baseUrl: "http://localhost:9100/v1",
      },
    ],
    modelConnections: [
      { id: "lab", catalogId: "openai", tag: "text", model: "lab-model", credentialId: "lab-key" },
    ],
    defaults: { text: "lab" },
  } as LabSettings;
  const payloads: any[] = [];
  let enabled = true;
  const upstream =
    options.upstream ??
    ((async (request: Request) => {
      const payload = await request.json();
      payloads.push(payload);
      const system = JSON.stringify(payload.messages?.[0]);
      const optimizer = system.includes("reflect_once_v1");
      const text = optimizer
        ? JSON.stringify({
            candidates: [
              {
                body: "Summarize the source and cite [S1].",
                explanation: "Require explicit source citations",
                sourceCaseIds: ["dev-0", "dev-1", "dev-2"],
              },
            ],
          })
        : options.regression && JSON.stringify(payload.messages.at(-1)).includes("source 0")
          ? system.includes("cite [S1]")
            ? "Summary without a citation"
            : "Summary [S1]"
          : system.includes("cite [S1]")
            ? "Summary [S1]"
            : "Summary without a citation";
      return new Response(
        JSON.stringify({
          id: "response",
          object: "chat.completion",
          created: 1,
          model: "lab-model",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
            cost: 0.001,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
  const controller = new OptimizationLabController(cwd, {
    root: join(cwd, "lab-store"),
    loadSettings: () => settings,
    enabled: () => enabled,
    upstream,
  });
  const prepared = controller.prepare({
    cwd,
    dataset,
    skillName: "lab-test",
    targetConnectionId: "lab",
    optimizerConnectionId: "lab",
    objective: "quality",
    limits: {
      maxRequests: options.maxRequests ?? 30,
      maxExecutionMs: 60000,
      maxOutputTokens: 1000,
      timeoutMs: 1000,
      maxCandidates: 1,
      repeats: 1,
    },
  });
  const grant = controller.grant(prepared.id, {
    expectedRevision: prepared.state.revision,
    planHash: prepared.plan.planHash,
    operationId: "native-confirm-1",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    limits: { maxRequests: options.maxRequests ?? 30, maxExecutionMs: 60000 },
  });
  return {
    controller,
    prepared,
    grant,
    payloads,
    settings,
    cwd,
    skillPath: join(skillDir, "SKILL.md"),
    skill,
    disable: () => {
      enabled = false;
    },
  };
}
async function wait(controller: OptimizationLabController, id: string) {
  for (let i = 0; i < 100; i++) {
    const snapshot = controller.get(id);
    if (
      !["baselining", "proposing", "screening", "final_evaluating"].includes(snapshot.state.status)
    )
      return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("experiment did not reach a checkpoint");
}
function grade(controller: OptimizationLabController, id: string) {
  const template = controller.exportGrading(id);
  template.reviewer = "local reviewer";
  for (const item of template.items)
    for (const result of item.grades) {
      result.verdict = "passed";
      result.evidence = "Read the supplied output against this criterion.";
    }
  return controller.importGrading(id, template, controller.get(id).state.revision);
}

test("six-case experiment closes without touching live Skill and never leaks holdout to optimizer", async () => {
  const s = setup();
  expect(s.payloads).toHaveLength(0);
  expect(s.prepared.estimate.worstCaseTokens).toBeNull();
  const started = s.controller.start(
    s.prepared.id,
    s.grant.state.revision,
    s.grant.grant!.startOperationId,
  );
  expect(
    s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId).id,
  ).toBe(started.id);
  const done = await wait(s.controller, s.prepared.id);
  expect(done.state.status).toBe("report_ready");
  expect(s.payloads).toHaveLength(13);
  expect(done.ledger.totals.requests).toBe(13);
  const optimization = s.payloads.find((payload) =>
    JSON.stringify(payload).includes("reflect_once_v1"),
  );
  expect(JSON.stringify(optimization)).not.toContain("Summarize source 3");
  expect(JSON.stringify(optimization)).not.toContain("hold-3");
  const report = s.controller.report(s.prepared.id);
  expect((report.json as any).denominators.plannedCases).toBe(6);
  expect((report.json as any).effect.conclusion).toBe("improved");
  expect(readFileSync(s.skillPath, "utf8")).toBe(s.skill);
  const firstHash = report.hash;
  expect(s.controller.report(s.prepared.id).hash).toBe(firstHash);
});

test("human checkpoints pause all model calls and grading export roundtrips directly", async () => {
  const s = setup({ human: true });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  const baseline = await wait(s.controller, s.prepared.id);
  expect(baseline.state.status).toBe("awaiting_baseline_grading");
  expect(s.payloads).toHaveLength(3);
  expect(() =>
    s.controller.start(s.prepared.id, baseline.state.revision, "continue-before-scores", true),
  ).toThrow("grading");
  const gradedBaseline = grade(s.controller, s.prepared.id);
  expect(s.payloads).toHaveLength(3);
  s.controller.start(s.prepared.id, gradedBaseline.state.revision, "continue-baseline", true);
  const screening = await wait(s.controller, s.prepared.id);
  expect(screening.state.status).toBe("awaiting_screening_grading");
  expect(s.payloads).toHaveLength(7);
  const gradedScreening = grade(s.controller, s.prepared.id);
  s.controller.start(s.prepared.id, gradedScreening.state.revision, "continue-screening", true);
  const done = await wait(s.controller, s.prepared.id);
  expect(done.state.status).toBe("report_ready");
  expect(s.payloads).toHaveLength(13);
  const incomplete = s.controller.report(s.prepared.id);
  expect((incomplete.json as any).effect.conclusion).toBe("inconclusive");
  grade(s.controller, s.prepared.id);
  const complete = s.controller.report(s.prepared.id);
  expect(complete.hash).not.toBe(incomplete.hash);
  expect((complete.json as any).effect.conclusion).toBe("improved");
  expect(s.payloads).toHaveLength(13);
});

test("selected configuration changes and disabled feature cannot reach upstream", async () => {
  const s = setup();
  s.settings.modelConnections[0]!.baseUrl = "http://localhost:9999/v1";
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  expect((await wait(s.controller, s.prepared.id)).state.status).toBe("failed");
  expect(s.payloads).toHaveLength(0);
  const other = setup();
  other.disable();
  expect(() =>
    other.controller.start(
      other.prepared.id,
      other.grant.state.revision,
      other.grant.grant!.startOperationId,
    ),
  ).toThrow("disabled");
  expect(other.payloads).toHaveLength(0);
});

test("final allocation prevents search consuming its reserved requests", async () => {
  const s = setup({ maxRequests: 6 });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  const snapshot = await wait(s.controller, s.prepared.id);
  expect(snapshot.state.status).toBe("budget_exhausted");
  expect(s.payloads).toHaveLength(0);
  expect(snapshot.ledger.finalAllocation.requests).toBe(6);
});

test("native budget renewal retains consumption and can continue an unissued step", async () => {
  const s = setup({ maxRequests: 6 });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  const exhausted = await wait(s.controller, s.prepared.id);
  expect(exhausted.state.status).toBe("budget_exhausted");
  const renewed = s.controller.grant(s.prepared.id, {
    expectedRevision: exhausted.state.revision,
    planHash: exhausted.plan.planHash,
    operationId: "native-renewal",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    limits: { maxRequests: 30, maxExecutionMs: 60000 },
  });
  expect(renewed.ledger.sequence).toBeGreaterThan(0);
  s.controller.start(s.prepared.id, renewed.state.revision, "explicit-resume", true);
  const done = await wait(s.controller, s.prepared.id);
  expect(done.state.status).toBe("report_ready");
  expect(done.ledger.totals.requests).toBe(13);
  expect(s.payloads).toHaveLength(13);
});

test("revoke interrupts a real in-flight fake HTTP request and preserves unknown usage", async () => {
  let entered = false;
  let receivedSignal: AbortSignal | undefined;
  const s = setup({
    upstream: (async (_request, init) => {
      entered = true;
      receivedSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("stopped", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch,
  });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  for (let i = 0; !entered && i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(entered).toBe(true);
  s.controller.revoke(s.prepared.id, s.controller.get(s.prepared.id).state.revision);
  const done = await wait(s.controller, s.prepared.id);
  expect(receivedSignal?.aborted).toBe(true);
  expect(done.state.status).toBe("cancelled");
  expect(done.ledger.totals.unknownTokens).toBeGreaterThan(0);
  expect(done.ledger.totals.requests).toBe(1);
});

test("inconclusive human feedback blocks optimizer until an explicit correction", async () => {
  const s = setup({ human: true });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  await wait(s.controller, s.prepared.id);
  const template = s.controller.exportGrading(s.prepared.id);
  template.reviewer = "reviewer";
  for (const item of template.items)
    for (const grade of item.grades) {
      grade.verdict = "inconclusive";
      grade.evidence = "Need source review";
    }
  const first = s.controller.importGrading(
    s.prepared.id,
    template,
    s.controller.get(s.prepared.id).state.revision,
  );
  expect(() => s.controller.start(s.prepared.id, first.state.revision, "not-yet", true)).toThrow(
    "grading",
  );
  const corrected = grade(s.controller, s.prepared.id);
  expect((corrected.state.data.gradingRefs as string[]).length).toBe(6);
  s.controller.start(s.prepared.id, corrected.state.revision, "after-correction", true);
  expect((await wait(s.controller, s.prepared.id)).state.status).toBe("awaiting_screening_grading");
});

test("new worker recovers dispatched steps as unknown and never replays them", async () => {
  const s = setup();
  const id = s.prepared.id;
  const plan = s.prepared.plan;
  const fence = s.controller.lease.acquire(id);
  const { canonicalJson, sha256Hex } = await import("./contracts/canonical-json.js");
  const identity = {
    planHash: plan.planHash,
    caseId: "dev-0",
    bodyHash: plan.skill.bodyHash,
    phase: "baseline",
    repeat: 0,
  };
  const trialId = sha256Hex(canonicalJson(identity));
  const operationId = "crash-trial";
  s.controller.store.mutate(id, { fence }, (state) => {
    state.status = "baselining";
    state.startedAt = new Date().toISOString();
    state.data.pending = { ...identity, trialId, operationId, body: plan.skill.body };
  });
  s.controller.ledger.beginOperation(id, fence, {
    operationId,
    role: "baseline",
    timeoutMs: plan.bounds.trial.timeoutMs,
    maxRequests: plan.bounds.trial.maxRequests,
    maxOutputTokens: plan.bounds.trial.maxOutputTokens,
  });
  const attempt = s.controller.ledger.reserveAttempt(id, fence, {
    operationId,
    estimatedTokens: 100,
    estimatedCostUsd: null,
  });
  s.controller.ledger.dispatch(id, fence, attempt.attemptId);
  s.controller.lease.release(id, fence);
  const recovered = new OptimizationLabController(s.cwd, s.controller.options);
  const interrupted = recovered.get(id);
  expect(interrupted.state.status).toBe("interrupted");
  expect(interrupted.ledger.totals.unknownTokens).toBe(100);
  expect(s.payloads).toHaveLength(0);
  const report = recovered.report(id);
  expect((report.json as any).trials[0].requestIds).toEqual([attempt.attemptId]);
  recovered.start(id, interrupted.state.revision, "explicit-recovery", true);
  const finished = await wait(recovered, id);
  expect(finished.state.status).toBe("failed");
  expect(s.payloads).toHaveLength(2);
  expect(JSON.stringify(s.payloads)).not.toContain("Summarize source 0");
  expect(JSON.stringify(s.payloads)).not.toContain("reflect_once_v1");
  expect(finished.ledger.totals.requests).toBe(3);
});

test("default Desktop controller reads user connections through full settings scope", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lab-user-settings-"));
  roots.push(cwd);
  const userDir = join(cwd, "isolated-home", ".code-shell");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, "settings.json"),
    JSON.stringify({
      credentials: [
        { id: "key", catalogId: "openai", apiKey: "fake-key", baseUrl: "http://localhost:9100/v1" },
      ],
      modelConnections: [
        {
          id: "user-only",
          catalogId: "openai",
          tag: "text",
          model: "lab-fixture",
          credentialId: "key",
        },
      ],
      defaults: { text: "user-only" },
    }),
  );
  const modulePath = new URL("./controller.ts", import.meta.url).pathname;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { OptimizationLabController } from ${JSON.stringify(modulePath)}; const controller = new OptimizationLabController(${JSON.stringify(cwd)}); process.stdout.write(JSON.stringify(controller.discover()));`,
    ],
    { env: { ...process.env, HOME: join(cwd, "isolated-home") }, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
  const discovered = JSON.parse(result.stdout.toString());
  expect(discovered.connections).toContainEqual({
    id: "user-only",
    label: "user-only",
    model: "lab-fixture",
    provider: "openai",
    eligible: true,
  });
});

test("optimizer without any issued HTTP can resume under a new budget without reusing a closed operation", async () => {
  const s = setup({ maxRequests: 9 });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  const exhausted = await wait(s.controller, s.prepared.id);
  expect(exhausted.state.status).toBe("budget_exhausted");
  expect(exhausted.ledger.totals.requests).toBe(3);
  expect(s.payloads).toHaveLength(3);
  const renewed = s.controller.grant(s.prepared.id, {
    expectedRevision: exhausted.state.revision,
    planHash: exhausted.plan.planHash,
    operationId: "native-optimizer-renewal",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    limits: { maxRequests: 30, maxExecutionMs: 60000 },
  });
  s.controller.start(s.prepared.id, renewed.state.revision, "resume-optimizer", true);
  const done = await wait(s.controller, s.prepared.id);
  expect(done.state.status).toBe("report_ready");
  expect(done.ledger.totals.requests).toBe(13);
  expect(
    s.payloads.filter((payload) => JSON.stringify(payload).includes("reflect_once_v1")),
  ).toHaveLength(1);
  const operations = Object.values(done.ledger.operations).filter(
    (operation) => operation.role === "optimizer",
  );
  expect(operations).toHaveLength(2);
  expect(operations.filter((operation) => operation.attemptIds.length > 0)).toHaveLength(1);
});

test("known development regressions veto candidate selection before any holdout request", async () => {
  const s = setup({ regression: true });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  const done = await wait(s.controller, s.prepared.id);
  expect(done.state.status).toBe("report_ready");
  expect(done.state.data.selectedBodyHash).toBeUndefined();
  expect(s.payloads).toHaveLength(7);
  expect(JSON.stringify(s.payloads)).not.toContain("Summarize source 3");
  expect((s.controller.report(s.prepared.id).json as any).effect.conclusion).not.toBe("improved");
});

test("fully graded semantic regression is vetoed independently of hard assertions", async () => {
  const s = setup({ human: true, semanticRegression: true });
  s.controller.start(s.prepared.id, s.grant.state.revision, s.grant.grant!.startOperationId);
  await wait(s.controller, s.prepared.id);
  const baseline = grade(s.controller, s.prepared.id);
  s.controller.start(s.prepared.id, baseline.state.revision, "semantic-propose", true);
  await wait(s.controller, s.prepared.id);
  const template = s.controller.exportGrading(s.prepared.id);
  template.reviewer = "reviewer";
  for (const item of template.items)
    for (const result of item.grades) {
      result.verdict = item.input.includes("source 0") ? "failed" : "passed";
      result.evidence = "Evaluated the current source against the same rubric.";
    }
  const screening = s.controller.importGrading(
    s.prepared.id,
    template,
    s.controller.get(s.prepared.id).state.revision,
  );
  s.controller.start(s.prepared.id, screening.state.revision, "semantic-select", true);
  const done = await wait(s.controller, s.prepared.id);
  expect(done.state.status).toBe("report_ready");
  expect(done.state.data.selectedBodyHash).toBeUndefined();
  expect(s.payloads).toHaveLength(7);
});

for (const knownCache of [true, false])
  test(`candidate cost tie-break requires comparable complete usage (${knownCache ? "known" : "unknown"} cache)`, async () => {
    const requests: any[] = [];
    const s = setup({
      upstream: (async (request) => {
        const body = await (request as Request).json();
        requests.push(body);
        const system = JSON.stringify(body.system);
        const optimizer = system.includes("reflect_once_v1");
        const text = optimizer
          ? JSON.stringify({
              candidates: ["expensive", "cheap"].map((name) => ({
                body: `Summarize and cite [S1]. ${name}`,
                explanation: "Require a citation",
                sourceCaseIds: ["dev-0", "dev-1", "dev-2"],
              })),
            })
          : system.includes("cite [S1]")
            ? "Summary [S1]"
            : "Summary without citation";
        return new Response(
          JSON.stringify({
            id: "response",
            type: "message",
            role: "assistant",
            model: "lab-model",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              cache_read_input_tokens: 0,
              ...(knownCache ? { cache_creation_input_tokens: 0 } : {}),
              cost: system.includes("cheap") ? 0.001 : 0.002,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    s.settings.credentials[0]!.catalogId = "anthropic";
    s.settings.modelConnections[0]!.catalogId = "anthropic";
    const { readFrozenDataset } = await import("./contracts/dataset.js");
    const frozen = readFrozenDataset(s.controller.store.root, s.prepared.plan.datasetHash);
    const prepared = s.controller.prepare({
      cwd: s.cwd,
      dataset: {
        schemaVersion: 1,
        title: frozen.title,
        taskFamily: frozen.taskFamily,
        cases: frozen.cases,
      },
      skillName: "lab-test",
      targetConnectionId: "lab",
      optimizerConnectionId: "lab",
      objective: "quality",
      limits: {
        maxRequests: 30,
        maxExecutionMs: 60000,
        maxOutputTokens: 1000,
        timeoutMs: 1000,
        maxCandidates: 2,
        repeats: 1,
      },
    });
    const grant = s.controller.grant(prepared.id, {
      expectedRevision: prepared.state.revision,
      planHash: prepared.plan.planHash,
      operationId: "two-candidate-grant",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      limits: { maxRequests: 30, maxExecutionMs: 60000 },
    });
    s.controller.start(prepared.id, grant.state.revision, grant.grant!.startOperationId);
    const done = await wait(s.controller, prepared.id);
    expect(done.state.status).toBe("report_ready");
    if (knownCache) {
      expect(done.state.data.selectedBodyHash).toBeDefined();
      expect((s.controller.report(prepared.id).json as any).change.bodyDiff).toContain("cheap");
      expect(requests).toHaveLength(16);
    } else {
      expect(done.state.data.selectedBodyHash).toBeUndefined();
      expect(requests).toHaveLength(10);
    }
  });
