import { describe, expect, test } from "bun:test";
import { renderMarkdownReport, summarizeResults } from "../evals/harness/report.mjs";

const result = (overrides = {}) => ({
  caseId: "recovery",
  trial: 1,
  executionStatus: "passed",
  hardAssertions: [{ id: "one-reply", passed: true }],
  semantic: { status: "passed", checks: [{ id: "answers-task", passed: true }] },
  evidenceLevel: "packaged_live_llm",
  requests: [],
  ...overrides,
});

describe("summarizeResults", () => {
  test("a positive semantic judge never overrides a hard failure", () => {
    const summary = summarizeResults([
      result({ hardAssertions: [{ id: "duplicate", passed: false }] }),
    ]);
    expect(summary.execution.passed).toBe(1);
    expect(summary.semantic.passed).toBe(1);
    expect(summary.hard.failed).toBe(1);
    expect(summary.outcomes.failed).toBe(1);
    expect(summary.cases.failed).toBe(1);
  });

  test("missing and unknown assertions are inconclusive, including an unevaluated judge", () => {
    const summary = summarizeResults([
      result({ trial: 1, hardAssertions: [] }),
      result({ trial: 2, hardAssertions: [{ id: "missing", passed: null }] }),
      result({ trial: 3, semantic: { status: "not_evaluated" } }),
    ]);
    expect(summary.hard).toEqual({ passed: 1, failed: 0, inconclusive: 2 });
    expect(summary.outcomes.inconclusive).toBe(3);
    expect(summary.passRate).toEqual({ passed: 0, denominator: 3, rate: 0 });
  });

  test("hard evidence does not rescue failed execution or a failed semantic check", () => {
    const summary = summarizeResults([
      result({ trial: 1, executionStatus: "failed" }),
      result({
        trial: 2,
        semantic: { status: "passed", checks: [{ id: "truthfulness", passed: false }] },
      }),
      result({
        trial: 3,
        semantic: { status: "passed", checks: [{ id: "quality", passed: null }] },
      }),
    ]);
    expect(summary.outcomes).toEqual({ passed: 0, failed: 2, inconclusive: 1, skipped: 0 });
    expect(summary.semantic).toEqual({ passed: 1, failed: 1, not_evaluated: 1, not_applicable: 0 });
  });

  test("separates trials, conservative case outcomes, and skipped denominators", () => {
    const summary = summarizeResults([
      result({ trial: 1 }),
      result({ trial: 2, hardAssertions: [{ id: "bad", passed: false }] }),
      result({ caseId: "good" }),
      result({ caseId: "environment", executionStatus: "inconclusive" }),
      result({
        caseId: "not-run",
        executionStatus: "skipped",
        evidenceLevel: "catalogue",
        hardAssertions: [],
        semantic: { status: "not_applicable" },
      }),
    ]);
    expect(summary.trialCount).toBe(5);
    expect(summary.caseCount).toBe(4);
    expect(summary.passRate).toEqual({ passed: 2, denominator: 4, rate: 0.5 });
    expect(summary.cases.passRate).toEqual({ passed: 1, denominator: 3, rate: 1 / 3 });
    expect(summary.executionInconclusiveTrials).toBe(1);
    expect(summary.unreachedTrials).toBe(1);
    expect(summary.byCase.find((entry) => entry.caseId === "recovery").outcome).toBe("failed");
  });

  test("a partially skipped case is not reported as passed", () => {
    const summary = summarizeResults([result(), result({ trial: 2, executionStatus: "skipped" })]);
    expect(summary.cases.inconclusive).toBe(1);
    expect(summary.passRate.rate).toBe(1);
  });

  test("keeps evidence scope separate and cannot pass a catalogue-only result", () => {
    const summary = summarizeResults([
      result(),
      result({
        caseId: "unit",
        evidenceLevel: "repository_regression",
        semantic: { status: "not_applicable" },
      }),
      result({ caseId: "catalogue", evidenceLevel: "catalogue" }),
    ]);
    expect(summary.evidence.packaged_live_llm.outcomes.passed).toBe(1);
    expect(summary.evidence.repository_regression.outcomes.passed).toBe(1);
    expect(summary.evidence.catalogue.outcomes.passed).toBe(0);
    expect(summary.evidence.catalogue.outcomes.inconclusive).toBe(1);
  });

  test("unknown provider usage is null with an explicit partial subtotal", () => {
    const summary = summarizeResults([
      result({
        requests: [
          { usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20, costUsd: 0 } },
          { usage: { inputTokens: null, outputTokens: 4, totalTokens: null, costUsd: null } },
        ],
      }),
    ]);
    expect(summary.usage.inputTokens).toEqual({
      total: null,
      knownTotal: 20,
      knownRequests: 1,
      unknownRequests: 1,
      complete: false,
    });
    expect(summary.usage.outputTokens.total).toBe(4);
    expect(summary.usage.totalTokens.total).toBeNull();
    expect(summary.usage.costUsd.total).toBeNull();
    expect(summary.usage.costUsd.knownTotal).toBe(0);
  });

  test("a missing live request log is unknown, not zero, unlike an explicit empty log", () => {
    const missing = summarizeResults([result({ requests: undefined })]);
    expect(missing.usage.unreportedLiveTrials).toBe(1);
    expect(missing.usage.inputTokens.total).toBeNull();
    expect(summarizeResults([result()]).usage.inputTokens.total).toBe(0);
    expect(summarizeResults([]).passRate.rate).toBeNull();
    expect(summarizeResults([]).usage.inputTokens.total).toBeNull();
  });

  test("invalid numeric usage cannot silently become measured zero", () => {
    const summary = summarizeResults([
      result({
        requests: [
          { usage: { inputTokens: "12", outputTokens: -1, totalTokens: NaN, costUsd: Infinity } },
        ],
      }),
    ]);
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "costUsd"]) {
      expect(summary.usage[field].total).toBeNull();
      expect(summary.usage[field].unknownRequests).toBe(1);
    }
  });

  test("rejects duplicate identities and incompatible status vocabularies", () => {
    expect(() => summarizeResults([result(), result()])).toThrow("Duplicate case/trial");
    expect(() => summarizeResults([result({ executionStatus: "completed" })])).toThrow(
      "executionStatus",
    );
    expect(() => summarizeResults([result({ evidenceLevel: "mock" })])).toThrow("evidenceLevel");
    expect(() =>
      summarizeResults([result({ hardAssertions: [{ id: "bad", passed: "true" }] })]),
    ).toThrow("verdict");
  });
});

describe("renderMarkdownReport", () => {
  test("shows identities, actual usage, zero fixture seed, budgets and not-run cases", () => {
    const markdown = renderMarkdownReport({
      run: {
        id: "synthetic-run",
        fixtureSeed: 0,
        model: { provider: "example", requested: "requested-v1" },
        budget: { maxRequests: 3, maxOutputTokens: 80 },
        app: { sha256: "app-hash", executableSha256: "exe-hash", version: "0.9.10" },
        selectedCaseIds: ["recovery", "pending"],
        trialsPerCase: 2,
      },
      cases: {
        cases: [
          { id: "recovery", title: "Recovery" },
          { id: "pending", title: "Pending" },
          { id: "not-selected", title: "Later" },
        ],
      },
      results: [
        result({
          requests: [
            {
              id: "r1",
              model: { responseModel: "actual-v2" },
              usage: { inputTokens: 12, outputTokens: null, totalTokens: null },
            },
          ],
        }),
      ],
    });
    expect(markdown).toContain("| Fixture seed | 0 |");
    expect(markdown).toContain("maxRequests: 3; maxOutputTokens: 80");
    expect(markdown).toContain("app-hash");
    expect(markdown).toContain("exe-hash");
    expect(markdown).toContain("requested-v1");
    expect(markdown).toContain("actual-v2");
    expect(markdown).toContain("| outputTokens | unknown | 0 | 1 |");
    expect(markdown).toContain("| pending | Pending | No executed result |");
    expect(markdown).toContain("| not-selected | Later | Not selected |");
    expect(markdown).toContain("Planned trials without a result: 3");
    expect(markdown).toContain("do not include absent planned trials");
  });

  test("does not assume requested model is the provider's response model", () => {
    const markdown = renderMarkdownReport({
      run: { model: "requested-only" },
      results: [result({ requests: [{}] })],
    });
    expect(markdown).toContain(
      "| recovery | 1 | 1 | unknown | unknown | requested-only | unknown |",
    );
  });

  test("trial-level model identity does not invent missing per-request identity", () => {
    const markdown = renderMarkdownReport({
      results: [
        result({
          model: { provider: "example", requested: "chosen", responseModel: "trial-observation" },
          requests: [{}],
        }),
      ],
    });
    expect(markdown).toContain("| recovery | 1 | example | chosen | trial-observation |");
    expect(markdown).toContain("| recovery | 1 | 1 | unknown | example | chosen | unknown |");
  });

  test("lists application and same-model judge roles while counting both requests", () => {
    const trial = result({
      hardAssertions: [{ id: "one-reply", passed: false }],
      requests: [
        {
          id: "app",
          role: "application",
          model: "actual-model",
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        },
        {
          id: "judge",
          role: "judge",
          model: "actual-model",
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        },
      ],
    });
    const summary = summarizeResults([trial]);
    const markdown = renderMarkdownReport({
      run: { semanticJudge: "same selected live model; advisory" },
      results: [trial],
    });
    expect(summary.usage.totalTokens.total).toBe(23);
    expect(summary.outcomes.failed).toBe(1);
    expect(markdown).toContain("| Semantic judge | same selected live model; advisory |");
    expect(markdown).toContain("| recovery | 1 | app | application |");
    expect(markdown).toContain("| recovery | 1 | judge | judge |");
    expect(markdown).toContain("not an independent-model or human review");
  });

  test("counts absent planned attempts even when the optional catalogue is omitted", () => {
    const markdown = renderMarkdownReport({ run: { trialsPerCase: 3 }, results: [result()] });
    expect(markdown).toContain("Planned trials without a result: 2");
    expect(markdown).toContain("| recovery | 1 | 1 | 0 | 0 | 0 | passed |");
  });

  test("does not render raw prompts, outputs, credentials, or arbitrary model fields", () => {
    const markdown = renderMarkdownReport({
      run: {
        model: { requested: "synthetic", apiKey: "DO-NOT-PRINT-KEY" },
        budget: { maxRequests: 1, apiKey: "DO-NOT-PRINT-BUDGET-KEY" },
      },
      results: [
        result({
          prompt: "DO-NOT-PRINT-PROMPT",
          output: "DO-NOT-PRINT-OUTPUT",
          requests: [
            {
              body: "DO-NOT-PRINT-BODY",
              model: { responseModel: "returned", secret: "DO-NOT-PRINT-SECRET" },
            },
          ],
        }),
      ],
    });
    expect(markdown).not.toContain("DO-NOT-PRINT");
    expect(markdown).toContain("returned");
  });

  test("escapes table-breaking and active HTML text in assertion details", () => {
    const markdown = renderMarkdownReport({
      results: [
        result({
          hardAssertions: [{ id: "a|b", passed: false, detail: "<script>bad</script>\nnext|row" }],
        }),
      ],
    });
    expect(markdown).toContain("a\\|b");
    expect(markdown).toContain("&lt;script&gt;bad&lt;/script&gt; / next\\|row");
    expect(markdown).not.toContain("<script>");
  });

  test("empty and entirely skipped runs do not invent a pass rate", () => {
    expect(renderMarkdownReport({ results: [], cases: [{ id: "todo" }] })).toContain(
      "No trial results.",
    );
    const markdown = renderMarkdownReport({
      results: [
        result({
          executionStatus: "skipped",
          reason: "No packaged app",
          hardAssertions: [],
          semantic: { status: "not_evaluated" },
        }),
      ],
      cases: [{ id: "recovery" }],
    });
    expect(markdown).toContain("not calculated (no non-skipped results)");
    expect(markdown).toContain("No packaged app");
    expect(markdown).toContain("No hard assertion evidence");
  });
});
