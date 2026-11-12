import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { installFixtureNetworkGuard } from "./helpers/network-fixture.js";

const network = installFixtureNetworkGuard(); // Evidence auditing never contacts a provider.
afterAll(() => network.restore());
const { scoreResponse } =
  await import("../docs/todo/prompt-cache-probes-20261111/complex-schema-probe-20261112.ts");
const { complexSchemaCases, compareComplexSchemaArgs } =
  await import("../docs/todo/prompt-cache-probes-20261111/complex-schema-cases-20261112.mjs");
const { costNanoUsd, LIMITS } =
  await import("../docs/todo/prompt-cache-probes-20261111/complex-probe-budget-20261112.mjs");
const evidenceText = readFileSync(
  new URL(
    "../docs/todo/prompt-cache-probes-20261111/complex-schema-evidence-20261112.json",
    import.meta.url,
  ),
  "utf8",
);
const evidence = JSON.parse(evidenceText);
const prior = JSON.parse(
  readFileSync(
    new URL(
      "../docs/todo/prompt-cache-probes-20261111/native-tool-reference-evidence-20261111.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const records: any[] = evidence.sources.flatMap((source: any) => source.records);
const modes = ["eager", "native", "call-tool"] as const;
const byNumber = new Map(records.map((record) => [record.requestNumber, record]));
const corrected = evidence.sources.find(
  (source: any) => source.phase === "corrected-native-and-portable",
);
const original = evidence.sources.find((source: any) => source.phase === "original-mixed-catalog");
const postHoc = evidence.sources.find((source: any) => source.phase === "post-hoc-pure-eager");

function sampleFor(record: any) {
  const sample =
    record.kind === "cache-append-call"
      ? complexSchemaCases.find((sample: any) => sample.toolName !== complexSchemaCases[0].toolName)
      : complexSchemaCases.find((sample: any) => sample.id === record.caseId);
  if (!sample) throw new Error(`Unknown sample for request ${record.requestNumber}`);
  return sample;
}
function recomputeDiagnostic(record: any) {
  const sample = sampleFor(record);
  const prescribed = scoreResponse(record.mode, sample, record.response);
  const direct = scoreResponse("eager", sample, record.response);
  const wrapped = scoreResponse("call-tool", sample, record.response);
  const call = record.response.content.filter((part: any) => part.type === "tool_use")[0];
  const inner = compareComplexSchemaArgs(
    call.input?.args ?? call.input,
    sample.expectedArgs,
  ).matches;
  const category = prescribed.correct
    ? "prescribed-exact"
    : wrapped.correct
      ? "valid-CallTool-in-direct-arm"
      : inner && !direct.schemaValid
        ? "invalid-outer-wrapper"
        : prescribed.schemaValid
          ? "schema-valid-semantic-error"
          : "other-failure";
  return {
    prescribedExact: prescribed.correct,
    directExact: direct.correct,
    callToolExact: wrapped.correct,
    permittedFormExact: direct.correct || wrapped.correct,
    innerParametersExactForDiagnosisOnly: inner,
    category,
  };
}
function primaryRows(mode: string) {
  const source = mode === "eager" ? original : corrected;
  return source.records.filter(
    (record: any) =>
      record.mode === mode && record.kind === "accuracy" && record.httpStatus === 200,
  );
}
function accuracySummary(rows: any[]) {
  const diagnostics = rows.map(recomputeDiagnostic);
  const categories: Record<string, number> = {};
  for (const diagnostic of diagnostics)
    categories[diagnostic.category] = (categories[diagnostic.category] ?? 0) + 1;
  return {
    attempts: rows.length,
    prescribedExact: diagnostics.filter((item) => item.prescribedExact).length,
    permittedFormExact: diagnostics.filter((item) => item.permittedFormExact).length,
    schemaValidInPrescribedForm: rows.filter(
      (record) => scoreResponse(record.mode, sampleFor(record), record.response).schemaValid,
    ).length,
    innerParametersExactForDiagnosisOnly: diagnostics.filter(
      (item) => item.innerParametersExactForDiagnosisOnly,
    ).length,
    categories,
    cases: complexSchemaCases.map((sample: any) => ({
      caseId: sample.id,
      outcomes: rows
        .filter((record) => record.caseId === sample.id)
        .map((record) => ({
          requestNumber: record.requestNumber,
          repetition: record.repetition,
          category: recomputeDiagnostic(record).category,
        })),
    })),
  };
}

test("all 80 attempts have unique audit and response identities, including the HTTP 400", () => {
  expect(evidence.endpoint).toBe(LIMITS.endpoint);
  expect(evidence.model).toBe(LIMITS.model);
  expect(evidence.sources.map((source: any) => source.phase)).toEqual([
    "original-mixed-catalog",
    "corrected-native-and-portable",
    "post-hoc-pure-eager",
  ]);
  expect(records.map((record) => record.requestNumber)).toEqual(
    Array.from({ length: 80 }, (_, index) => index + 1),
  );
  expect(byNumber.size).toBe(80);
  expect(new Set(evidence.sources.map((source: any) => source.runId)).size).toBe(3);
  expect(new Set(records.map((record) => `${record.phase}:${record.stage}`)).size).toBe(80);
  expect(
    new Set(records.map((record) => record.response.id ?? record.response.request_id)).size,
  ).toBe(80);
  expect(records.filter((record) => record.httpStatus === 200)).toHaveLength(79);
  for (const source of evidence.sources) {
    expect(source.records).toHaveLength(source.requestsMade);
    expect(source.runId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    expect(source.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(source.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(source.criteria).toMatchObject({
      exactRepeatMinimumHitFraction: 0.95,
      appendedHistoryMaximumUncachedPriorTokens: 32,
    });
    for (const record of source.records) {
      expect(record.phase).toBe(source.phase);
      expect(Date.parse(record.startedAt)).toBeGreaterThanOrEqual(Date.parse(source.startedAt));
      for (const key of ["requestHash", "toolsHash", "systemHash", "messagesHash"])
        expect(record[key]).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(record.bodyBytes)).toBe(true);
      expect(record.bodyBytes).toBeGreaterThan(0);
      expect(record.bodyBytes).toBeLessThanOrEqual(LIMITS.maxBodyBytes);
      if (record.httpStatus === 200) {
        expect(record.response.id).toMatch(/^msg_/);
        expect(record.response.model).toBe(LIMITS.model);
        expect(record.response.provider).toBe("Anthropic");
        expect(Date.parse(record.completedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt));
        expect(Date.parse(record.completedAt)).toBeLessThanOrEqual(Date.parse(source.finishedAt));
      }
    }
  }
});

test("response contents reproduce every stored score without credit for repaired argument wrappers", () => {
  const scored = records.filter((record) => record.score);
  expect(scored).toHaveLength(58); // 48 primary, 8 post-hoc, and 2 auxiliary calls.
  for (const record of scored) {
    expect(record.httpStatus).toBe(200);
    expect(record.score).toEqual(scoreResponse(record.mode, sampleFor(record), record.response));
    if (record.diagnostic) expect(record.diagnostic).toEqual(recomputeDiagnostic(record));
  }
  const primary = modes.flatMap(primaryRows);
  expect(primary).toHaveLength(48);
  expect(new Set(primary.map((record) => record.requestNumber)).size).toBe(48);
  expect(primary.some((record) => record.requestNumber === 20)).toBe(false);
  for (const mode of modes) {
    const rows = primaryRows(mode);
    expect(rows).toHaveLength(16);
    for (const sample of complexSchemaCases)
      expect(
        rows
          .filter((record: any) => record.caseId === sample.id)
          .map((record: any) => record.repetition),
      ).toEqual([0, 1]);
    expect(evidence.primary[mode]).toEqual(accuracySummary(rows));
  }
  expect(evidence.primary.eager).toMatchObject({
    prescribedExact: 6,
    permittedFormExact: 8,
    innerParametersExactForDiagnosisOnly: 16,
  });
  expect(evidence.primary.native).toMatchObject({
    attempts: 16,
    prescribedExact: 10,
    permittedFormExact: 11,
  });
  expect(evidence.primary["call-tool"].prescribedExact).toBe(16);
  const invalidWrappers = primary.filter(
    (record) => recomputeDiagnostic(record).category === "invalid-outer-wrapper",
  );
  expect(invalidWrappers).toHaveLength(12);
  expect(
    invalidWrappers.every(
      (record) => !record.score.correct && !record.diagnostic.permittedFormExact,
    ),
  ).toBe(true);
});

test("post-hoc pure eager and auxiliary calls stay separate from matched primary denominators", () => {
  expect(postHoc.records).toHaveLength(8);
  expect(
    postHoc.records.every(
      (record: any) =>
        record.mode === "eager" && record.kind === "accuracy" && record.repetition === 0,
    ),
  ).toBe(true);
  expect(evidence.postHocPureEagerControl).toEqual(accuracySummary(postHoc.records));
  expect(evidence.postHocPureEagerControl).toMatchObject({ attempts: 8, prescribedExact: 7 });
  const auxiliary = records.filter((record) => record.kind === "cache-append-call");
  expect(auxiliary.map((record) => record.mode)).toEqual(["native", "call-tool"]);
  expect(evidence.auxiliaryAccuracy).toEqual({
    attempts: auxiliary.length,
    correct: auxiliary.filter(
      (record) => scoreResponse(record.mode, sampleFor(record), record.response).correct,
    ).length,
  });
  expect(evidence.auxiliaryAccuracy).toEqual({ attempts: 2, correct: 2 });
});

test("the failed native request is unscored and permanently retains its unknown bill", () => {
  const failed = records.filter((record) => record.httpStatus !== 200);
  expect(failed).toHaveLength(1);
  const record = failed[0];
  expect(record).toMatchObject({
    requestNumber: 20,
    phase: "original-mixed-catalog",
    mode: "native",
    kind: "accuracy",
    httpStatus: 400,
    accountingStatus: "charged-reservation",
    usage: null,
  });
  expect(record.score).toBeUndefined();
  expect(record.diagnostic).toBeUndefined();
  expect(record.billedNanoUsd).toBeUndefined();
  expect(record.response.request_id).toMatch(/^gen-/);
  expect(record.response).toMatchObject({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Tool definitions/code execution functions cannot be mixed with other content",
    },
  });
  expect(evidence.httpErrorAccounting).toHaveLength(1);
  expect(evidence.httpErrorAccounting[0]).toMatchObject({
    requestNumber: record.requestNumber,
    stage: record.stage,
    actualBill: "unknown",
    status: "charged-reservation",
    httpStatus: 400,
    reservationNanoUsd: record.retainedUnknownBillReservationNanoUsd,
  });
  for (const key of ["requestEvidenceSha256", "responseEvidenceSha256"])
    expect(evidence.httpErrorAccounting[0][key]).toMatch(/^[a-f0-9]{64}$/);
  const reserved =
    ((2 * record.bodyBytes + LIMITS.overheadTokens) * LIMITS.inputUsdPerMillion +
      LIMITS.maxOutputTokens * LIMITS.outputUsdPerMillion) *
    1000;
  expect(record.retainedUnknownBillReservationNanoUsd).toBe(reserved);
  expect(reserved).toBe(420_832_000);
});

test("integer billed amounts plus unknown exposure reproduce the cumulative USD 2 budget", () => {
  const successful = records.filter((record) => record.httpStatus === 200);
  let newKnown = 0n;
  for (const record of successful) {
    const usage = record.usage;
    for (const key of ["input", "cacheRead", "cacheWrite", "output", "totalInput"]) {
      expect(Number.isSafeInteger(usage[key])).toBe(true);
      expect(usage[key]).toBeGreaterThanOrEqual(0);
    }
    expect(usage.totalInput).toBe(usage.input + usage.cacheRead + usage.cacheWrite);
    expect(usage.totalInput).toBeLessThanOrEqual(2 * record.bodyBytes + LIMITS.overheadTokens);
    expect(usage.output).toBeLessThanOrEqual(LIMITS.maxOutputTokens);
    expect(record.accountingStatus).toBe("settled");
    expect(record.billedNanoUsd).toBe(costNanoUsd(usage.reportedCostUsd));
    newKnown += BigInt(record.billedNanoUsd);
  }
  const priorKnown = prior.records.reduce(
    (total: bigint, record: any) => total + BigInt(costNanoUsd(record.usage.reportedCostUsd)),
    0n,
  );
  const unknown = records.reduce(
    (total, record) => total + BigInt(record.retainedUnknownBillReservationNanoUsd ?? 0),
    0n,
  );
  const conservative = priorKnown + newKnown + unknown;
  expect(evidence.budget).toEqual({
    ceilingNanoUsd: LIMITS.budgetNanoUsd,
    priorRequests: prior.requestsAttempted,
    priorKnownNanoUsd: Number(priorKnown),
    newAttempts: records.length,
    newSuccessfulRequests: successful.length,
    newKnownNanoUsd: Number(newKnown),
    knownTotalNanoUsd: Number(priorKnown + newKnown),
    retainedUnknownBillReservationNanoUsd: Number(unknown),
    conservativeTotalNanoUsd: Number(conservative),
    remainingNanoUsd: Number(BigInt(LIMITS.budgetNanoUsd) - conservative),
    pendingRequests: 0,
  });
  expect(priorKnown).toBe(50_524_600n);
  expect(newKnown).toBe(356_761_500n);
  expect(conservative).toBeLessThanOrEqual(2_000_000_000n);
  expect(records.some((record) => record.accountingStatus === "pending")).toBe(false);
});

test.each(modes)(
  "%s cache conclusions follow usage, timestamps and preserved request hashes",
  (mode) => {
    const source = mode === "eager" ? original : corrected;
    const rows = source.records.filter(
      (record: any) => record.mode === mode && record.httpStatus === 200,
    );
    const repeated = rows.filter(
      (record: any) => record.kind === "accuracy" && record.repetition === 1,
    );
    expect(repeated).toHaveLength(8);
    for (const repeat of repeated) {
      const first = rows.find(
        (record: any) =>
          record.kind === "accuracy" && record.caseId === repeat.caseId && record.repetition === 0,
      );
      for (const key of ["requestHash", "toolsHash", "systemHash", "messagesHash"])
        expect(repeat[key]).toBe(first[key]);
    }
    const checks = rows
      .filter((record: any) => record.kind.startsWith("cache-"))
      .map((record: any) => {
        const check: any = {
          stage: record.stage,
          kind: record.kind,
          ...record.usage,
          hitFraction: record.usage.cacheRead / record.usage.totalInput,
        };
        if (record.kind.startsWith("cache-append-")) {
          const previous =
            record.kind === "cache-append-discover"
              ? primaryRows(mode)[0]
              : byNumber.get(record.requestNumber - 1)!;
          expect(record.previousInputTokens).toBe(previous.usage.totalInput);
          expect(record.previousRequestCompletedAt).toBe(previous.completedAt);
          const age = Date.parse(record.startedAt) - Date.parse(previous.completedAt);
          expect(age).toBeGreaterThanOrEqual(0);
          Object.assign(check, {
            previousInputTokens: previous.usage.totalInput,
            previousRequestAgeMs: age,
            priorPrefixWithinTtl: age < 300_000,
            priorPrefixCovered: record.usage.cacheRead >= previous.usage.totalInput - 32,
          });
        }
        return check;
      });
    const cold = rows.find((record: any) => record.kind === "cache-cold-control");
    const restored = rows.find((record: any) => record.kind === "cache-restored");
    const warm =
      mode === "eager"
        ? repeated.at(-1)
        : rows.find((record: any) => record.kind === "cache-resume");
    expect(restored.requestHash).toBe(warm.requestHash);
    expect(cold.toolsHash).not.toBe(warm.toolsHash);
    expect(cold.systemHash).toBe(warm.systemHash);
    expect(cold.messagesHash).toBe(warm.messagesHash);
    for (const record of rows.filter((record: any) => record !== cold)) {
      expect(record.toolsHash).toBe(warm.toolsHash);
      expect(record.systemHash).toBe(warm.systemHash);
    }
    if (mode !== "eager")
      expect(warm.requestHash).toBe(
        rows.find((record: any) => record.kind === "cache-append-receipt").requestHash,
      );
    const append = checks.filter((check: any) => check.kind.startsWith("cache-append-"));
    const recomputed = {
      exactRepeatReads: repeated.map((record: any) => ({
        caseId: record.caseId,
        read: record.usage.cacheRead,
        total: record.usage.totalInput,
        hitFraction: record.usage.cacheRead / record.usage.totalInput,
      })),
      exactRepeatsWarm:
        repeated.length === 8 &&
        repeated.every((record: any) => record.usage.cacheRead / record.usage.totalInput >= 0.95),
      checks,
      warmFullPrefix:
        warm.usage.cacheRead > 0 && warm.usage.cacheRead / warm.usage.totalInput >= 0.95,
      negativeControlCold: cold.usage.cacheRead === 0 && cold.usage.cacheWrite > 0,
      restoredWarm: restored.usage.cacheRead / restored.usage.totalInput >= 0.95,
      historyPrefixCovered:
        mode === "eager"
          ? null
          : append.length === 3 &&
            append.every((check: any) => check.priorPrefixWithinTtl && check.priorPrefixCovered),
      historyCacheExpired: append.some((check: any) => !check.priorPrefixWithinTtl),
    };
    expect(evidence.cache[mode]).toEqual(recomputed);
    expect(recomputed).toMatchObject({
      exactRepeatsWarm: true,
      warmFullPrefix: true,
      negativeControlCold: true,
      restoredWarm: true,
      historyPrefixCovered: mode === "eager" ? null : true,
      historyCacheExpired: false,
    });
  },
);

test("published evidence contains no headers, credentials, or local operator paths", () => {
  const forbidden: string[] = [];
  const inspect = (value: any, path = "root") => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:headers|authorization|proxy-authorization|x-api-key|api[-_]?key|credential|credentials|cookie|set-cookie)$/i.test(
          key,
        )
      )
        forbidden.push(`${path}.${key}`);
      inspect(entry, `${path}.${key}`);
    }
  };
  inspect(evidence);
  expect(forbidden).toEqual([]);
  expect(evidenceText).not.toMatch(
    /Bearer\s+\S+|sk-or-v1-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|\/Users\/|\/private\/tmp\//,
  );
});
