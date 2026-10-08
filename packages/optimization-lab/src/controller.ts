import { randomUUID } from "node:crypto";
import {
  isFeatureEnabled,
  SettingsManager,
  readSkillSnapshot,
} from "@cjhyy/code-shell-core/extension";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import { freezeDataset, readFrozenDataset, type DatasetManifest } from "./contracts/dataset.js";
import {
  createExperimentPlan,
  worstCaseTokens,
  type ExperimentPlan,
  type OperationLimits,
} from "./contracts/experiment.js";
import { assertGrantActive, createBudgetGrant } from "./contracts/grant.js";
import { VERDICT_POLICY_SUITE_VERSION } from "./contracts/verdict-policy.js";
import {
  ExperimentStore,
  type ExperimentSnapshot,
  type ExperimentStatus,
  type LeaseFence,
} from "./store.js";
import { ExperimentLease } from "./lease.js";
import { ExperimentLedger } from "./ledger.js";
import { labRoot, projectKey } from "./store-paths.js";
import {
  assertSameConnection,
  discoverConnections,
  resolveSelectedConnection,
  type LabSettings,
  type ResolvedConnection,
} from "./providers/connection.js";
import type { MeterAccounting } from "./providers/metered-fetch.js";
import { runTrial, type Trial } from "./runner.js";
import { reflectOnce } from "./strategy.js";
import type { Candidate } from "./candidate.js";
import {
  createGradingTemplate,
  fullyGraded,
  importGrading,
  verifyGradingRecord,
  GRADING_VERSION,
  type GradingMapping,
  type GradingRecord,
  type GradingTemplate,
} from "./grading.js";
import { buildReport, trialVerdict } from "./report.js";

const positive = z.number().int().positive().safe();
export const PrepareSchema = z
  .object({
    cwd: z.string().min(1),
    dataset: z.unknown(),
    skillName: z.string().min(1).max(256),
    targetConnectionId: z.string().min(1).max(256),
    optimizerConnectionId: z.string().min(1).max(256),
    objective: z.enum(["quality", "cost"]),
    limits: z
      .object({
        maxRequests: positive.max(10000),
        maxExecutionMs: positive.max(86400000),
        maxOutputTokens: positive.max(131072),
        timeoutMs: positive.max(600000),
        maxCandidates: positive.max(2),
        repeats: positive.max(3),
        maxBodyBytes: positive.max(512 * 1024).optional(),
        maxContextBytes: positive.max(4 * 1024 * 1024).optional(),
      })
      .strict(),
  })
  .strict();

export interface ControllerOptions {
  loadSettings?: () => LabSettings;
  enabled?: () => boolean;
  upstream?: typeof globalThis.fetch;
  root?: string;
}
type PendingTrial = {
  caseId: string;
  bodyHash: string;
  body: string;
  phase: Trial["phase"];
  repeat: number;
  operationId: string;
  trialId: string;
};
interface Progress {
  trialRefs: string[];
  candidateRefs: string[];
  gradingRefs: string[];
  templateRef?: string;
  mappingRef?: string;
  selectedBodyHash?: string;
  baselineGradingHashes?: string[];
  screeningGradingHashes?: string[];
  resumeStatus?: ExperimentStatus;
  pending?: PendingTrial;
  pendingOptimizer?: boolean;
  optimizerRef?: string;
  reportRef?: string;
  reportMarkdownRef?: string;
  runOperations?: string[];
  preparedLimits?: { maxRequests: number; maxExecutionMs: number };
  grantOperations?: string[];
  terminalReason?: string;
}
const activeStages = new Set<ExperimentStatus>([
  "baselining",
  "proposing",
  "screening",
  "final_evaluating",
]);

/** One scheduler per experiment. Disk leases and ledger fencing remain authoritative across processes. */
export class OptimizationLabController {
  readonly store: ExperimentStore;
  readonly lease: ExperimentLease;
  readonly ledger: ExperimentLedger;
  private readonly running = new Map<string, AbortController>();
  private readonly loadSettings: () => LabSettings;
  private readonly enabled: () => boolean;
  constructor(
    readonly cwd: string,
    readonly options: ControllerOptions = {},
  ) {
    this.store = new ExperimentStore(options.root ?? labRoot(cwd));
    this.lease = new ExperimentLease(this.store);
    this.ledger = new ExperimentLedger(this.store);
    this.loadSettings = options.loadSettings ?? (() => new SettingsManager(cwd).get());
    this.enabled =
      options.enabled ??
      (() =>
        isFeatureEnabled(
          new SettingsManager(cwd).getForScope("user").featureFlags,
          "optimization_lab",
        ));
  }
  discover() {
    return {
      connections: discoverConnections(this.loadSettings()),
      supportedMode: "text_fragment",
      supportedJudgeMode: "human",
      automaticAdoption: false,
    };
  }
  list() {
    return this.store
      .list()
      .map((snapshot) => ({
        id: snapshot.state.id,
        revision: snapshot.state.revision,
        status: snapshot.state.status,
        planHash: snapshot.plan.planHash,
        title: snapshot.plan.skill.name,
        startedAt: snapshot.state.startedAt,
      }));
  }

  prepare(raw: unknown) {
    const input = PrepareSchema.parse(raw);
    if (projectKey(input.cwd) !== projectKey(this.cwd)) throw new Error("project mismatch");
    const frozen = freezeDataset(input.dataset, this.store.root);
    if (!frozen.ok)
      throw new Error(`dataset invalid: ${frozen.issues.map((item) => item.code).join(", ")}`);
    const dataset = readFrozenDataset(this.store.root, frozen.manifest.datasetHash);
    const skill = readSkillSnapshot(input.skillName, this.cwd);
    if (!skill || skill.revisionKind !== "bundle" || skill.extraFiles?.length !== 0)
      throw new Error("P1a requires a safely readable single-file Skill bundle");
    const frontmatterOriginal = skill.markdown.match(/^---\s*\n([\s\S]*?)---\s*\n?/)?.[0] ?? "";
    const settings = this.loadSettings();
    const target = resolveSelectedConnection(settings, input.targetConnectionId);
    const optimizer = resolveSelectedConnection(settings, input.optimizerConnectionId);
    const maxContextBytes = input.limits.maxContextBytes ?? 256 * 1024;
    const limits: OperationLimits = {
      maxRequests: 1,
      maxOutputTokens: input.limits.maxOutputTokens,
      timeoutMs: input.limits.timeoutMs,
      inputTokenUpperBound: null,
    };
    const holdoutOperations =
      dataset.cases.filter((item) => item.split === "holdout" && item.readiness === "runnable")
        .length *
      2 *
      input.limits.repeats;
    const finalAllocation = {
      requests: holdoutOperations * limits.maxRequests,
      estimatedTokens: holdoutOperations * (maxContextBytes + 8192 + limits.maxOutputTokens),
      estimatedCostUsd: null,
      executionMs: holdoutOperations * limits.timeoutMs,
    };
    const plan = createExperimentPlan({
      schemaVersion: 1,
      projectKey: projectKey(this.cwd),
      datasetHash: dataset.datasetHash,
      skill: {
        name: skill.name,
        source: skill.source,
        revision: skill.revision,
        revisionKind: "bundle",
        markdown: skill.markdown,
        body: skill.body,
        frontmatterOriginal,
        markdownHash: sha256Hex(skill.markdown),
        bodyHash: sha256Hex(skill.body),
        extraFiles: [],
      },
      connections: { target: target.identity, optimizer: optimizer.identity },
      runnerVersion: "text_fragment_v1",
      strategyVersion: "reflect_once_v1",
      estimatorVersion: "utf8_conservative_v1",
      verdictPolicySuiteVersion: VERDICT_POLICY_SUITE_VERSION,
      scorerHash: sha256Hex(
        canonicalJson({
          version: GRADING_VERSION,
          criteria: dataset.cases.map((item) => ({
            id: item.id,
            hardAssertions: item.hardAssertions,
            rubric: item.rubric,
          })),
        }),
      ),
      judgeMode: "human",
      objective: {
        kind: input.objective,
        description:
          input.objective === "quality"
            ? "Fix at least one verified holdout failure without regressions"
            : "Reduce comparable provider-reported cost by at least 10% without quality regressions",
      },
      acceptance: {
        criticalHardAssertionIds: dataset.cases.flatMap((item) =>
          item.hardAssertions.map((assertion) => `${item.id}/${assertion.id}`),
        ),
        regressionCaseIds: dataset.cases
          .filter((item) => item.caseRole === "regression")
          .map((item) => item.id),
        qualityNoRegression: true,
        minFixes: 1,
        minCostReductionRatio: 0.1,
        costComparableOnly: true,
        minHoldoutSourceGroups: 3,
        minPairedCases: 3,
      },
      bounds: {
        concurrency: 1,
        maxCandidates: input.limits.maxCandidates,
        repeats: input.limits.repeats,
        maxBodyBytes:
          input.limits.maxBodyBytes ?? Math.max(64 * 1024, Buffer.byteLength(skill.body)),
        maxContextBytes,
        trial: limits,
        optimization: limits,
      },
      externalData: {
        target: "current_case_input_and_skill",
        optimizer: "skill_and_dev_feedback",
        judge: "none",
      },
      finalAllocation,
    });
    // Inputs and full reflection material must fit before any authorization or network request.
    if (
      dataset.cases.some(
        (item) =>
          item.readiness === "runnable" &&
          Buffer.byteLength(item.input + skill.body, "utf8") + 512 > maxContextBytes,
      )
    )
      throw new Error("case input and Skill exceed frozen context bound");
    const created = this.store.create(plan);
    const snapshot = this.store.mutate(created.state.id, {}, (state) => {
      state.data = {
        trialRefs: [],
        candidateRefs: [],
        gradingRefs: [],
        preparedLimits: {
          maxRequests: input.limits.maxRequests,
          maxExecutionMs: input.limits.maxExecutionMs,
        },
      };
    });
    const devOperations =
      dataset.summary.runnableDev * input.limits.repeats * (1 + input.limits.maxCandidates);
    return {
      ...snapshot,
      id: snapshot.state.id,
      datasetSummary: dataset.summary,
      estimate: {
        maxRequests: input.limits.maxRequests,
        maxExecutionMs: input.limits.maxExecutionMs,
        plannedRequests: (devOperations + 1) * limits.maxRequests + finalAllocation.requests,
        finalReservedRequests: finalAllocation.requests,
        worstCaseTokens: worstCaseTokens(plan, input.limits.maxRequests),
        worstCaseCostUsd: null,
        reasoningBound:
          target.identity.outputCapCoversReasoning === true &&
          optimizer.identity.outputCapCoversReasoning === true
            ? "bounded"
            : "unknown",
        warning:
          "No published price snapshot is available. Token and cost stop thresholds are estimates; aliases, reasoning, missing usage and provider billing can remain unknown. Authorization expires during human grading waits.",
      },
    };
  }

  private data(snapshot: ExperimentSnapshot): Progress {
    return snapshot.state.data as unknown as Progress;
  }
  private trials(id: string, data: Progress) {
    return (data.trialRefs ?? []).map((hash) => this.store.getJson<Trial>(id, "trials", hash));
  }
  private candidates(id: string, data: Progress) {
    return (data.candidateRefs ?? []).map((hash) =>
      this.store.getJson<Candidate>(id, "candidates", hash),
    );
  }
  private grades(id: string, data: Progress) {
    return (data.gradingRefs ?? []).map((hash) => {
      const record = this.store.getJson<GradingRecord>(id, "grading", hash);
      verifyGradingRecord(record);
      return record;
    });
  }
  private snapshot(id: string) {
    const snapshot = this.store.read(id);
    const dataset = readFrozenDataset(this.store.root, snapshot.plan.datasetHash);
    const limits = this.data(snapshot).preparedLimits;
    const maxRequests =
      snapshot.grant?.maxRequests ?? limits?.maxRequests ?? snapshot.plan.finalAllocation.requests;
    const maxExecutionMs =
      snapshot.grant?.maxExecutionMs ??
      limits?.maxExecutionMs ??
      snapshot.plan.finalAllocation.executionMs;
    return {
      ...snapshot,
      id,
      ledger: this.ledger.summary(id),
      datasetSummary: dataset.summary,
      estimate: {
        maxRequests,
        maxExecutionMs,
        plannedRequests:
          (dataset.summary.runnableDev *
            snapshot.plan.bounds.repeats *
            (1 + snapshot.plan.bounds.maxCandidates) +
            1) *
            snapshot.plan.bounds.trial.maxRequests +
          snapshot.plan.finalAllocation.requests,
        finalReservedRequests: snapshot.plan.finalAllocation.requests,
        worstCaseTokens: worstCaseTokens(snapshot.plan, Math.max(1, maxRequests)),
        worstCaseCostUsd: null,
        reasoningBound: "unknown",
        warning:
          "Token and fee bounds are unknown. Selected model aliases must match actual response model IDs. Auth-only credential rotation is permitted; connection configuration changes require a new plan.",
      },
    };
  }

  get(id: string) {
    const snapshot = this.store.read(id);
    if (
      activeStages.has(snapshot.state.status) &&
      !this.running.has(id) &&
      (!snapshot.lease || snapshot.lease.expiresAt <= Date.now())
    ) {
      const fence = this.lease.acquire(id);
      try {
        this.ledger.recoverUnknown(id, fence);
        const progress = this.data(snapshot);
        if (progress.pending) {
          const p = progress.pending;
          const dataset = readFrozenDataset(this.store.root, snapshot.plan.datasetHash);
          const item = dataset.cases.find((item) => item.id === p.caseId)!;
          const trial: Trial = {
            schemaVersion: 1,
            trialId: p.trialId,
            planHash: snapshot.plan.planHash,
            caseId: p.caseId,
            caseHash: dataset.caseHashes[p.caseId]!,
            bodyHash: p.bodyHash,
            phase: p.phase,
            repeat: p.repeat,
            requestModel: snapshot.plan.connections.target.modelId,
            responseModel: null,
            status: "unknown",
            output: null,
            assertions: [],
            semanticStatus: item.rubric.length ? "not_evaluated" : "not_applicable",
            requestIds: [],
            observations: [],
            elapsedMs: snapshot.plan.bounds.trial.timeoutMs,
            reason: "worker interrupted; uncertain request is never replayed",
          };
          const ref = this.store.putJson(id, "trials", trial, fence);
          this.store.mutate(id, { fence }, (state) => {
            const d = state.data as unknown as Progress;
            d.trialRefs.push(ref.hash);
            delete d.pending;
          });
        }
        this.store.mutate(id, { fence }, (state) => {
          const d = state.data as unknown as Progress;
          d.resumeStatus = snapshot.state.status;
          state.status = "interrupted";
        });
        this.writeReport(id, fence);
      } finally {
        this.lease.release(id, fence);
      }
    }
    return this.snapshot(id);
  }

  grant(
    id: string,
    input: {
      expectedRevision: number;
      planHash: string;
      operationId: string;
      limits: {
        maxRequests: number;
        maxExecutionMs: number;
        maxEstimatedTokens?: number | null;
        maxEstimatedCostUsd?: number | null;
      };
      expiresAt: string;
    },
  ) {
    const snapshot = this.store.read(id);
    const data = this.data(snapshot);
    if (data.grantOperations?.includes(input.operationId)) return this.snapshot(id);
    if (snapshot.plan.planHash !== input.planHash) throw new Error("grant plan mismatch");
    if (["cancelled", "failed", "report_ready"].includes(snapshot.state.status))
      throw new Error("terminal experiment cannot be authorized");
    if (this.running.has(id) || activeStages.has(snapshot.state.status))
      throw new Error("pause the experiment before changing authorization");
    if (!this.enabled()) throw new Error("Optimization Lab is disabled");
    const grant = createBudgetGrant(
      {
        schemaVersion: 1,
        planHash: input.planHash,
        revision: snapshot.state.grantRevision + 1,
        confirmedAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        startOperationId: snapshot.grant?.startOperationId ?? input.operationId,
        maxRequests: input.limits.maxRequests,
        maxExecutionMs: input.limits.maxExecutionMs,
        maxEstimatedTokens: input.limits.maxEstimatedTokens ?? null,
        maxEstimatedCostUsd: input.limits.maxEstimatedCostUsd ?? null,
        enforcementMode: "reserved_estimate",
        revokedAt: null,
        revocationReason: null,
      },
      snapshot.plan.planHash,
    );
    const appended = this.store.appendGrant(id, grant, input.expectedRevision);
    this.store.mutate(id, { expectedRevision: appended.state.revision }, (state) => {
      const d = state.data as unknown as Progress;
      d.grantOperations = [...(d.grantOperations ?? []), input.operationId];
      if (state.status === "ready") state.status = "authorized";
    });
    return this.snapshot(id);
  }

  start(id: string, expectedRevision: number, operationId: string, resume = false) {
    let snapshot = this.store.read(id);
    const data = this.data(snapshot);
    if (data.runOperations?.includes(operationId)) return this.snapshot(id);
    if (snapshot.state.revision !== expectedRevision) throw new Error("stale state revision");
    if (!snapshot.grant) throw new Error("experiment is not authorized");
    assertGrantActive(snapshot.grant, snapshot.plan.planHash);
    if (!this.enabled()) throw new Error("Optimization Lab is disabled");
    if (
      !resume &&
      (snapshot.state.status !== "authorized" || operationId !== snapshot.grant.startOperationId)
    )
      throw new Error("first start must match the authorized start operation");
    if (
      resume &&
      ![
        "awaiting_baseline_grading",
        "awaiting_screening_grading",
        "interrupted",
        "budget_exhausted",
      ].includes(snapshot.state.status)
    )
      throw new Error("experiment is not resumable");
    const dataset = readFrozenDataset(this.store.root, snapshot.plan.datasetHash);
    const phase = snapshot.state.status === "awaiting_baseline_grading" ? "baseline" : "screening";
    if (
      snapshot.state.status.startsWith("awaiting_") &&
      !fullyGraded(
        this.trials(id, data).filter((trial) => trial.phase === phase),
        dataset,
        this.grades(id, data),
      )
    )
      throw new Error("required human grading is incomplete");
    if (
      snapshot.state.status === "budget_exhausted" &&
      snapshot.grant.revision <= Number(snapshot.state.data.exhaustedGrantRevision ?? 0)
    )
      throw new Error("budget exhausted; a new native authorization is required");
    const fence = this.lease.acquire(id);
    try {
      snapshot = this.store.mutate(id, { expectedRevision, fence }, (state) => {
        const d = state.data as unknown as Progress;
        d.runOperations = [...(d.runOperations ?? []), operationId];
        if (!state.startedAt) state.startedAt = new Date().toISOString();
        if (state.status === "awaiting_baseline_grading") {
          d.baselineGradingHashes = [...d.gradingRefs];
          state.status = "proposing";
        } else if (state.status === "awaiting_screening_grading") {
          d.screeningGradingHashes = [...d.gradingRefs];
          state.status = "screening";
        } else if (["interrupted", "budget_exhausted"].includes(state.status))
          state.status = d.resumeStatus ?? "baselining";
        else state.status = "baselining";
      });
      const abort = new AbortController();
      this.running.set(id, abort);
      void this.run(id, fence, abort)
        .catch(() => {})
        .finally(() => this.running.delete(id));
    } catch (error) {
      this.lease.release(id, fence);
      throw error;
    }
    return this.snapshot(id);
  }

  stop(id: string, expectedRevision: number) {
    this.store.requestStop(id, expectedRevision);
    this.running.get(id)?.abort();
    const snapshot = this.store.read(id);
    if (!this.running.has(id) && !activeStages.has(snapshot.state.status)) {
      this.store.mutate(id, {}, (state) => {
        state.status = "cancelled";
      });
      this.writeReport(id);
    }
    return this.snapshot(id);
  }
  revoke(id: string, expectedRevision: number) {
    const snapshot = this.store.read(id);
    if (!snapshot.grant) throw new Error("no authorization to revoke");
    this.store.appendGrant(
      id,
      {
        ...snapshot.grant,
        revision: snapshot.grant.revision + 1,
        revokedAt: new Date().toISOString(),
        revocationReason: "revoked by native user action",
      },
      expectedRevision,
    );
    this.running.get(id)?.abort();
    return this.snapshot(id);
  }

  exportGrading(id: string) {
    const snapshot = this.get(id);
    const data = this.data(snapshot);
    if (!data.templateRef) throw new Error("no human grading checkpoint is available");
    return this.store.getJson<GradingTemplate>(id, "templates", data.templateRef);
  }
  importGrading(id: string, raw: unknown, expectedRevision: number) {
    const snapshot = this.store.read(id);
    const data = this.data(snapshot);
    if (snapshot.state.revision !== expectedRevision) throw new Error("stale state revision");
    if (activeStages.has(snapshot.state.status))
      throw new Error("cannot change grading during execution");
    if (!data.mappingRef) throw new Error("no grading template is available");
    const mapping = this.store.getJson<GradingMapping>(id, "mappings", data.mappingRef);
    const records = importGrading(
      raw,
      mapping,
      this.grades(id, data),
      undefined,
      data.templateRef
        ? this.store.getJson<GradingTemplate>(id, "templates", data.templateRef)
        : undefined,
    );
    const refs = records.map((record) => this.store.putJson(id, "grading", record).hash);
    this.store.mutate(id, { expectedRevision }, (state) => {
      const d = state.data as unknown as Progress;
      d.gradingRefs = [...new Set([...d.gradingRefs, ...refs])];
    });
    if (snapshot.state.status === "report_ready") this.writeReport(id);
    return this.snapshot(id);
  }
  report(id: string) {
    const snapshot = this.get(id);
    const data = this.data(snapshot);
    if (!data.reportRef || !data.reportMarkdownRef) throw new Error("report is not available yet");
    const json = this.store.getJson(id, "reports", data.reportRef);
    const markdown = this.store.getText(id, "reports", data.reportMarkdownRef, "md");
    return { hash: data.reportRef, json, markdown };
  }

  private resolve(plan: ExperimentPlan, role: "target" | "optimizer"): ResolvedConnection {
    const resolved = resolveSelectedConnection(
      this.loadSettings(),
      plan.connections[role].connectionId,
    );
    assertSameConnection(resolved, plan.connections[role]);
    return resolved;
  }
  private accounting(
    id: string,
    fence: LeaseFence,
    operationId: string,
    limits: OperationLimits,
    role: "baseline" | "optimizer" | "screening" | "final",
  ): MeterAccounting {
    const plan = this.store.read(id).plan;
    this.ledger.beginOperation(id, fence, {
      operationId,
      role,
      timeoutMs: limits.timeoutMs,
      maxRequests: limits.maxRequests,
      maxOutputTokens: limits.maxOutputTokens,
      finalPhase: role === "final",
    });
    return {
      check: () => {
        if (!this.enabled()) throw new Error("Optimization Lab disabled");
        this.store.assertAdmitted(id, fence);
        this.resolve(plan, role === "optimizer" ? "optimizer" : "target");
      },
      admit: (attemptId) =>
        this.ledger.reserveAttempt(id, fence, {
          operationId,
          attemptId,
          estimatedTokens:
            (limits.inputTokenUpperBound ?? plan.bounds.maxContextBytes + 8192) +
            limits.maxOutputTokens,
          estimatedCostUsd: null,
        }),
      dispatch: (attemptId) => this.ledger.dispatch(id, fence, attemptId),
      finish: (observation) => {
        if (observation.outcome === "unknown" || !observation.usage)
          this.ledger.unknown(
            id,
            fence,
            observation.attemptId,
            "missing provider evidence or interrupted HTTP",
          );
        else
          this.ledger.settle(id, fence, {
            attemptId: observation.attemptId,
            responseModel: observation.responseModel,
            actualCostUsd: observation.usage.reportedCostUsd,
            usage: {
              inputTokens: observation.usage.inputTokens,
              outputTokens: observation.usage.outputTokens,
              cacheReadTokens: observation.usage.cacheReadTokens,
              cacheWriteTokens: observation.usage.cacheCreationTokens,
              reasoningTokens: observation.usage.reasoningTokens,
              reasoningIncludedInOutput: true,
            },
          });
      },
    };
  }

  private async executeTrial(
    id: string,
    fence: LeaseFence,
    abort: AbortController,
    item: DatasetManifest["cases"][number],
    body: string,
    phase: Trial["phase"],
    repeat: number,
  ) {
    const snapshot = this.store.read(id);
    const plan = snapshot.plan;
    const identity = {
      planHash: plan.planHash,
      caseId: item.id,
      bodyHash: sha256Hex(body),
      phase,
      repeat,
    };
    const trialId = sha256Hex(canonicalJson(identity));
    if (this.trials(id, this.data(snapshot)).some((trial) => trial.trialId === trialId)) return;
    const operationId = `trial-${trialId.slice(0, 40)}-${randomUUID()}`;
    this.store.mutate(id, { fence }, (state) => {
      (state.data as unknown as Progress).pending = { ...identity, body, operationId, trialId };
    });
    let trial: Trial;
    try {
      const accounting =
        item.readiness === "runnable"
          ? this.accounting(
              id,
              fence,
              operationId,
              plan.bounds.trial,
              phase === "holdout" ? "final" : phase === "baseline" ? "baseline" : "screening",
            )
          : {
              check() {},
              admit() {
                throw new Error("analysis-only cannot send HTTP");
              },
              dispatch() {},
              finish() {},
            };
      trial = await runTrial({
        plan,
        case: item,
        body,
        phase,
        repeat,
        connection: this.resolve(plan, "target"),
        accounting,
        signal: abort.signal,
        upstream: this.options.upstream,
      });
      if (item.readiness === "runnable")
        this.ledger.finishOperation(id, fence, operationId, trial.elapsedMs);
    } catch (error) {
      const operation = this.ledger.summary(id).operations[operationId];
      if (!operation || operation.attemptIds.length === 0) {
        if (operation) this.ledger.finishOperation(id, fence, operationId, 0);
        this.store.mutate(id, { fence }, (state) => {
          delete (state.data as unknown as Progress).pending;
        });
      }
      throw error;
    }
    const ref = this.store.putJson(
      id,
      "trials",
      { ...trial, grantRevision: snapshot.grant?.revision ?? null },
      fence,
    );
    this.store.mutate(id, { fence }, (state) => {
      const d = state.data as unknown as Progress;
      d.trialRefs.push(ref.hash);
      delete d.pending;
    });
    if (abort.signal.aborted) throw new Error("experiment stopped");
    if (trial.status === "unknown" || trial.status === "failed")
      throw new Error("trial evidence is incomplete");
  }

  private checkpoint(
    id: string,
    fence: LeaseFence,
    phase: "baseline" | "screening" | "holdout",
    nextStatus: ExperimentStatus,
  ): boolean {
    const snapshot = this.store.read(id);
    const data = this.data(snapshot);
    const dataset = readFrozenDataset(this.store.root, snapshot.plan.datasetHash);
    const trials = this.trials(id, data).filter((trial) => trial.phase === phase);
    if (fullyGraded(trials, dataset, this.grades(id, data))) return false;
    const { template, mapping } = createGradingTemplate(id, phase, dataset, trials);
    const templateRef = this.store.putJson(id, "templates", template, fence).hash;
    const mappingRef = this.store.putJson(id, "mappings", mapping, fence).hash;
    this.store.mutate(id, { fence }, (state) => {
      const d = state.data as unknown as Progress;
      d.templateRef = templateRef;
      d.mappingRef = mappingRef;
      state.status = nextStatus;
    });
    return true;
  }

  private selectCandidate(id: string, fence: LeaseFence): string | null {
    const snapshot = this.store.read(id);
    const data = this.data(snapshot);
    const dataset = readFrozenDataset(this.store.root, snapshot.plan.datasetHash);
    const grades = this.grades(id, data);
    const trials = this.trials(id, data);
    const candidates = this.candidates(id, data);
    const ranked = candidates
      .map((candidate) => {
        const own = trials.filter(
          (trial) => trial.bodyHash === candidate.bodyHash && trial.phase === "screening",
        );
        const values = own.map((trial) => trialVerdict(trial, dataset, grades));
        const valid =
          own.length === dataset.summary.dev * snapshot.plan.bounds.repeats &&
          !values.some((value, index) => value === null && own[index]!.status !== "skipped");
        return {
          candidate,
          valid,
          passed: values.filter((value) => value === true).length,
          hardFailures: own.reduce(
            (sum, trial) => sum + trial.assertions.filter((item) => !item.passed).length,
            0,
          ),
        };
      })
      .filter((entry) => entry.valid)
      .sort((a, b) => a.hardFailures - b.hardFailures || b.passed - a.passed);
    if (!ranked.length) return null;
    if (
      ranked.length > 1 &&
      ranked[0]!.hardFailures === ranked[1]!.hardFailures &&
      ranked[0]!.passed === ranked[1]!.passed
    )
      return null;
    const selected = ranked[0]!.candidate.bodyHash;
    this.store.mutate(id, { fence }, (state) => {
      (state.data as unknown as Progress).selectedBodyHash = selected;
    });
    return selected;
  }

  private async run(id: string, fence: LeaseFence, abort: AbortController) {
    let heartbeat = 0;
    const timer = setInterval(() => {
      try {
        if (!this.enabled()) {
          abort.abort();
          return;
        }
        const snapshot = this.store.assertAdmitted(id, fence);
        if (snapshot.state.stopRequested) abort.abort();
        if (++heartbeat % 5 === 0) this.lease.heartbeat(id, fence);
      } catch {
        abort.abort();
      }
    }, 250);
    try {
      for (;;) {
        if (abort.signal.aborted) throw new Error("experiment stopped");
        const snapshot = this.store.assertAdmitted(id, fence);
        const plan = snapshot.plan;
        const data = this.data(snapshot);
        const dataset = readFrozenDataset(this.store.root, plan.datasetHash);
        const dev = dataset.cases.filter((item) => item.split === "dev");
        if (snapshot.state.status === "baselining") {
          for (const item of dev)
            for (let repeat = 0; repeat < plan.bounds.repeats; repeat++)
              await this.executeTrial(id, fence, abort, item, plan.skill.body, "baseline", repeat);
          if (
            this.trials(id, this.data(this.store.read(id))).some(
              (trial) =>
                trial.phase === "baseline" && !["completed", "skipped"].includes(trial.status),
            )
          )
            throw new Error("baseline execution evidence is incomplete");
          if (this.checkpoint(id, fence, "baseline", "awaiting_baseline_grading")) return;
          this.store.mutate(id, { fence }, (state) => {
            state.status = "proposing";
          });
        } else if (snapshot.state.status === "proposing") {
          if (data.pendingOptimizer)
            throw new Error("interrupted optimizer operation cannot be replayed");
          if (!data.optimizerRef) {
            const operationId = `optimizer-${plan.planHash}`;
            const accounting = this.accounting(
              id,
              fence,
              operationId,
              plan.bounds.optimization,
              "optimizer",
            );
            this.store.mutate(id, { fence }, (state) => {
              (state.data as unknown as Progress).pendingOptimizer = true;
            });
            const result = await reflectOnce({
              plan,
              devCases: dev,
              trials: this.trials(id, data).filter((trial) => trial.phase === "baseline"),
              feedback: this.grades(id, data)
                .filter((record) =>
                  (data.baselineGradingHashes ?? data.gradingRefs).includes(
                    sha256Hex(canonicalJson(record)),
                  ),
                )
                .map((record) => ({
                  trialId: record.trialId,
                  semanticPassed: record.semanticPassed,
                  criteria: record.grades,
                })),
              connection: this.resolve(plan, "optimizer"),
              accounting,
              signal: abort.signal,
              upstream: this.options.upstream,
            });
            this.ledger.finishOperation(id, fence, operationId, result.execution.elapsedMs);
            const optimizerRef = this.store.putJson(id, "optimization", result, fence).hash;
            const candidateRefs = result.candidates.map(
              (candidate) => this.store.putJson(id, "candidates", candidate, fence).hash,
            );
            this.store.mutate(id, { fence }, (state) => {
              const d = state.data as unknown as Progress;
              d.optimizerRef = optimizerRef;
              d.candidateRefs = candidateRefs;
              delete d.pendingOptimizer;
            });
            if (!result.candidates.length)
              throw new Error("no valid candidate returned by the single reflection operation");
          }
          this.store.mutate(id, { fence }, (state) => {
            state.status = "screening";
          });
        } else if (snapshot.state.status === "screening") {
          for (const candidate of this.candidates(id, data))
            for (const item of dev)
              for (let repeat = 0; repeat < plan.bounds.repeats; repeat++)
                await this.executeTrial(
                  id,
                  fence,
                  abort,
                  item,
                  candidate.body,
                  "screening",
                  repeat,
                );
          if (this.checkpoint(id, fence, "screening", "awaiting_screening_grading")) return;
          const selected = data.selectedBodyHash ?? this.selectCandidate(id, fence);
          if (!selected) {
            this.store.mutate(id, { fence }, (state) => {
              state.status = "report_ready";
              (state.data as unknown as Progress).terminalReason =
                "screening evidence cannot distinguish candidates; no selection forced";
            });
            this.writeReport(id, fence);
            return;
          }
          this.store.mutate(id, { fence }, (state) => {
            state.status = "final_evaluating";
          });
        } else if (snapshot.state.status === "final_evaluating") {
          const selected = this.candidates(id, data).find(
            (candidate) => candidate.bodyHash === data.selectedBodyHash,
          );
          if (!selected) throw new Error("frozen selected candidate is missing");
          for (const item of dataset.cases.filter((item) => item.split === "holdout"))
            for (let repeat = 0; repeat < plan.bounds.repeats; repeat++) {
              const bodies =
                repeat % 2 === 0
                  ? [plan.skill.body, selected.body]
                  : [selected.body, plan.skill.body];
              for (const body of bodies)
                await this.executeTrial(id, fence, abort, item, body, "holdout", repeat);
            }
          this.checkpoint(id, fence, "holdout", "report_ready");
          this.store.mutate(id, { fence }, (state) => {
            state.status = "report_ready";
          });
          this.writeReport(id, fence);
          return;
        } else return;
      }
    } catch (error) {
      try {
        const snapshot = this.store.read(id);
        const summary = this.ledger.summary(id);
        let status: ExperimentStatus = "failed";
        const message = error instanceof Error ? error.message : "experiment failed";
        if (snapshot.state.stopRequested || snapshot.grant?.revokedAt || !this.enabled())
          status = "cancelled";
        else if (
          /budget|resources|allocation|exhaust|grant expired|deadline/iu.test(message) ||
          summary.estimateInvalid
        )
          status = "budget_exhausted";
        this.store.mutate(id, { fence }, (state) => {
          const d = state.data as unknown as Progress;
          d.resumeStatus = state.status;
          d.terminalReason =
            status === "failed" ? "execution failed or evidence incomplete" : status;
          state.status = status;
          if (status === "budget_exhausted")
            state.data.exhaustedGrantRevision = snapshot.grant?.revision ?? 0;
        });
        this.writeReport(id, fence);
      } catch {
        /* A lost owner cannot make late writes. The next worker recovers conservatively. */
      }
    } finally {
      clearInterval(timer);
      try {
        this.lease.release(id, fence);
      } catch {
        /* Durable fencing remains authoritative. */
      }
    }
  }

  private writeReport(id: string, fence?: LeaseFence) {
    const snapshot = this.store.read(id);
    const data = this.data(snapshot);
    const dataset = readFrozenDataset(this.store.root, snapshot.plan.datasetHash);
    const report = buildReport({
      plan: snapshot.plan,
      dataset,
      trials: this.trials(id, data),
      grades: this.grades(id, data),
      candidates: this.candidates(id, data),
      selectedBodyHash: data.selectedBodyHash ?? null,
      status: snapshot.state.status,
      ledger: this.ledger.summary(id),
      optimization: data.optimizerRef
        ? this.store.getJson(id, "optimization", data.optimizerRef)
        : null,
      feedbackHashes: [
        ...(data.baselineGradingHashes ?? []),
        ...(data.screeningGradingHashes ?? []),
      ],
    });
    const reportRef = this.store.putJson(id, "reports", report.json, fence).hash;
    if (reportRef !== report.hash) throw new Error("report canonical hash mismatch");
    const reportMarkdownRef = this.store.putText(id, "reports", report.markdown, fence, "md").hash;
    this.store.mutate(id, { fence }, (state) => {
      const d = state.data as unknown as Progress;
      d.reportRef = reportRef;
      d.reportMarkdownRef = reportMarkdownRef;
    });
  }
}
