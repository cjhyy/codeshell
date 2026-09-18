const EXECUTION_STATUSES = ["passed", "failed", "inconclusive", "skipped"];
const SEMANTIC_STATUSES = ["passed", "failed", "not_evaluated", "not_applicable"];
const EVIDENCE_LEVELS = ["packaged_live_llm", "repository_regression", "catalogue"];
const USAGE_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "costUsd"];

const counts = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function checkStatus(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`Invalid ${field}: ${String(value)}`);
  return value;
}

function normalizeChecks(checks = []) {
  if (!Array.isArray(checks)) throw new TypeError("Assertions/checks must be arrays");
  return checks.map((check) => {
    if (!check || typeof check.id !== "string" || !check.id.trim()) {
      throw new TypeError("Assertions/checks require an id");
    }
    const passed = check.passed ?? null;
    if (passed !== true && passed !== false && passed !== null) {
      throw new TypeError(`Invalid assertion verdict: ${check.id}`);
    }
    return { id: check.id, passed, detail: check.detail };
  });
}

function normalizeResults(results) {
  if (!Array.isArray(results)) throw new TypeError("Results must be an array");
  const identities = new Set();
  return results.map((result) => {
    if (!result || typeof result.caseId !== "string" || !result.caseId.trim()) {
      throw new TypeError("Results require a caseId");
    }
    const trial = result.trial ?? 1;
    if (!Number.isSafeInteger(trial) || trial < 1) throw new TypeError("Invalid trial number");
    const identity = JSON.stringify([result.caseId, trial]);
    if (identities.has(identity)) throw new TypeError(`Duplicate case/trial: ${identity}`);
    identities.add(identity);
    const executionStatus = checkStatus(
      result.executionStatus,
      EXECUTION_STATUSES,
      "executionStatus",
    );
    const evidenceLevel = checkStatus(result.evidenceLevel, EVIDENCE_LEVELS, "evidenceLevel");
    const hardAssertions = normalizeChecks(result.hardAssertions);
    const hardStatus = hardAssertions.some((check) => check.passed === false)
      ? "failed"
      : hardAssertions.length > 0 && hardAssertions.every((check) => check.passed === true)
        ? "passed"
        : "inconclusive";
    const semantic = result.semantic ?? { status: "not_evaluated" };
    const semanticChecks = normalizeChecks(semantic.checks);
    let semanticStatus = checkStatus(semantic.status, SEMANTIC_STATUSES, "semantic.status");
    // An aggregate judge label cannot erase an explicit failed or unknown check.
    if (semanticChecks.some((check) => check.passed === false)) semanticStatus = "failed";
    else if (semanticChecks.some((check) => check.passed === null))
      semanticStatus = "not_evaluated";
    let outcome;
    if (executionStatus === "failed" || hardStatus === "failed" || semanticStatus === "failed") {
      outcome = "failed";
    } else if (executionStatus === "skipped") {
      outcome = "skipped";
    } else if (
      executionStatus === "inconclusive" ||
      evidenceLevel === "catalogue" ||
      hardStatus === "inconclusive" ||
      semanticStatus === "not_evaluated"
    ) {
      outcome = "inconclusive";
    } else {
      outcome = "passed";
    }
    if (result.requests !== undefined && !Array.isArray(result.requests)) {
      throw new TypeError("requests must be an array when supplied");
    }
    return {
      ...result,
      trial,
      executionStatus,
      evidenceLevel,
      hardAssertions,
      hardStatus,
      semanticStatus,
      semanticChecks,
      outcome,
    };
  });
}

function summarizeUsage(results) {
  const requests = results.flatMap((result) => result.requests ?? []);
  const requestLogTrials = results.filter((result) => result.requests !== undefined).length;
  const unreportedLiveTrials = results.filter(
    (result) =>
      result.evidenceLevel === "packaged_live_llm" &&
      result.executionStatus !== "skipped" &&
      result.requests === undefined,
  ).length;
  const usage = { recordedRequests: requests.length, requestLogTrials, unreportedLiveTrials };
  for (const field of USAGE_FIELDS) {
    const values = requests.map((request) => request?.usage?.[field]);
    const known = values.filter(numeric);
    const knownTotal = known.reduce((sum, value) => sum + value, 0);
    const unknownRequests = values.length - known.length;
    const complete = requestLogTrials > 0 && unknownRequests === 0 && unreportedLiveTrials === 0;
    usage[field] = {
      total: complete ? knownTotal : null,
      knownTotal,
      knownRequests: known.length,
      unknownRequests,
      complete,
    };
  }
  return usage;
}

function passRate(outcomes) {
  const denominator = outcomes.passed + outcomes.failed + outcomes.inconclusive;
  return {
    passed: outcomes.passed,
    denominator,
    rate: denominator ? outcomes.passed / denominator : null,
  };
}

/**
 * One result per (caseId, positive integer trial). Execution, hard assertions,
 * semantic evaluation, and evidence scope remain independent. No model output,
 * prompt, credential, or private configuration is needed by this module.
 * Requests use { model?, usage: { inputTokens, outputTokens, totalTokens, costUsd } };
 * missing usage is unknown, while an explicit empty request log records zero requests.
 */
export function summarizeResults(results) {
  const trials = normalizeResults(results);
  const execution = counts(EXECUTION_STATUSES);
  const hard = counts(["passed", "failed", "inconclusive"]);
  const semantic = counts(SEMANTIC_STATUSES);
  const outcomes = counts(EXECUTION_STATUSES);
  const evidence = Object.fromEntries(
    EVIDENCE_LEVELS.map((level) => [level, { trials: 0, outcomes: counts(EXECUTION_STATUSES) }]),
  );
  const grouped = new Map();
  for (const trial of trials) {
    execution[trial.executionStatus]++;
    hard[trial.hardStatus]++;
    semantic[trial.semanticStatus]++;
    outcomes[trial.outcome]++;
    evidence[trial.evidenceLevel].trials++;
    evidence[trial.evidenceLevel].outcomes[trial.outcome]++;
    if (!grouped.has(trial.caseId)) grouped.set(trial.caseId, []);
    grouped.get(trial.caseId).push(trial);
  }
  const caseOutcomes = counts(EXECUTION_STATUSES);
  const byCase = [...grouped].map(([caseId, entries]) => {
    const trialOutcomes = counts(EXECUTION_STATUSES);
    for (const entry of entries) trialOutcomes[entry.outcome]++;
    // A failed attempt remains a failed case; a partial set of skipped attempts
    // is not a completely passed case. Planned but absent trials need run metadata.
    const outcome = trialOutcomes.failed
      ? "failed"
      : trialOutcomes.skipped === entries.length
        ? "skipped"
        : trialOutcomes.inconclusive || trialOutcomes.skipped
          ? "inconclusive"
          : "passed";
    caseOutcomes[outcome]++;
    return { caseId, trials: entries.length, outcomes: trialOutcomes, outcome };
  });
  return {
    trialCount: trials.length,
    caseCount: byCase.length,
    execution,
    hard,
    semantic,
    outcomes,
    passRate: passRate(outcomes),
    cases: { ...caseOutcomes, passRate: passRate(caseOutcomes) },
    byCase,
    evidence,
    unreachedTrials: trials.filter(
      (trial) => trial.executionStatus === "skipped" || trial.evidenceLevel === "catalogue",
    ).length,
    executionInconclusiveTrials: execution.inconclusive,
    usage: summarizeUsage(trials),
  };
}

function cell(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replace(/[|`[\]*_!]/g, "\\$&")
    .replace(/\r\n|\r|\n/g, " / ");
}

function table(headers, rows) {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function rateText(rate) {
  return rate.rate === null
    ? "not calculated (no non-skipped results)"
    : `${rate.passed}/${rate.denominator} (${(100 * rate.rate).toFixed(1)}%)`;
}

function modelIdentity(model, responseOnly = false) {
  if (typeof model === "string") {
    return responseOnly ? { responseModel: model } : { requested: model };
  }
  return model && typeof model === "object" ? model : {};
}

function budgetText(budget) {
  if (budget === null || budget === undefined) return "unknown";
  if (typeof budget !== "object") return String(budget);
  return (
    Object.entries(budget)
      .filter(
        ([key, value]) =>
          !/api.?key|secret|authorization|password|credential/i.test(key) &&
          (value === null || ["string", "number", "boolean"].includes(typeof value)),
      )
      .map(([key, value]) => `${key}: ${value ?? "unknown"}`)
      .join("; ") || "unknown"
  );
}

/** Render a report from sanitized result metadata, without reading files or using the network. */
export function renderMarkdownReport({ run = {}, results, cases = [] }) {
  const trials = normalizeResults(results);
  const summary = summarizeResults(results);
  const catalogue = Array.isArray(cases) ? cases : cases.cases;
  if (!Array.isArray(catalogue)) throw new TypeError("cases must be an array or a catalogue");
  const caseMap = new Map(
    catalogue.map((entry) => [typeof entry === "string" ? entry : entry.id, entry]),
  );
  const selected = new Set(
    run.selectedCaseIds ??
      (catalogue.length ? caseMap.keys() : trials.map((trial) => trial.caseId)),
  );
  const plannedCases = new Set([...caseMap.keys(), ...selected]);
  const notRun = [...plannedCases].filter(
    (id) =>
      !trials.some(
        (trial) =>
          trial.caseId === id &&
          trial.executionStatus !== "skipped" &&
          trial.evidenceLevel !== "catalogue",
      ),
  );
  const missingTrials = [];
  if (Number.isSafeInteger(run.trialsPerCase) && run.trialsPerCase > 0) {
    for (const caseId of selected) {
      for (let trial = 1; trial <= run.trialsPerCase; trial++) {
        if (!trials.some((result) => result.caseId === caseId && result.trial === trial)) {
          missingTrials.push([caseId, trial]);
        }
      }
    }
  }
  const model = modelIdentity(run.model);
  const app = run.app ?? {};
  const lines = [
    "# Runtime reliability evaluation",
    "",
    "This report covers only the listed cases, trials, and evidence levels. Catalogue entries are not executions. Semantic judgments cannot override hard failures; they do not establish full application coverage.",
    "",
    table(
      ["Run metadata", "Value"],
      [
        ["Run", run.id],
        ["Started", run.startedAt],
        ["Fixture seed", run.fixtureSeed],
        ["Requested provider", model.provider],
        ["Requested model", model.requested],
        ["Response model (run metadata)", model.responseModel],
        ["Model budget", budgetText(run.budget)],
        ["Semantic judge", run.semanticJudge ?? "not configured"],
        ["App version", app.version],
        ["App ASAR SHA256", app.asarSha256 ?? app.sha256],
        ["App executable SHA256", app.executableSha256],
        ["Planned trials per selected case", run.trialsPerCase],
      ],
    ),
    "",
    "## Results",
    "",
    `Observed trial pass rate: ${rateText(summary.passRate)}. Skipped outcomes are excluded; inconclusive outcomes remain in the denominator.`,
    `Observed case pass rate: ${rateText(summary.cases.passRate)}. A failed trial fails its case. These rates do not include absent planned trials.`,
    `Unreached trials: ${summary.unreachedTrials}. Execution-inconclusive trials (including environment limitations): ${summary.executionInconclusiveTrials}. Planned trials without a result: ${missingTrials.length}.`,
    "",
    table(
      [
        "Dimension",
        "Passed",
        "Failed",
        "Inconclusive",
        "Skipped / not evaluated",
        "Not applicable",
      ],
      [
        [
          "Execution",
          summary.execution.passed,
          summary.execution.failed,
          summary.execution.inconclusive,
          summary.execution.skipped,
          "—",
        ],
        [
          "Hard assertions",
          summary.hard.passed,
          summary.hard.failed,
          summary.hard.inconclusive,
          "—",
          "—",
        ],
        [
          "Semantic",
          summary.semantic.passed,
          summary.semantic.failed,
          "—",
          summary.semantic.not_evaluated,
          summary.semantic.not_applicable,
        ],
        [
          "Trial outcome",
          summary.outcomes.passed,
          summary.outcomes.failed,
          summary.outcomes.inconclusive,
          summary.outcomes.skipped,
          "—",
        ],
        [
          "Observed case outcome",
          summary.cases.passed,
          summary.cases.failed,
          summary.cases.inconclusive,
          summary.cases.skipped,
          "—",
        ],
      ],
    ),
    "",
    "## Evidence scope",
    "",
    table(
      ["Evidence level", "Trials", "Passed", "Failed", "Inconclusive", "Skipped"],
      Object.entries(summary.evidence).map(([level, value]) => [
        level,
        value.trials,
        ...EXECUTION_STATUSES.map((status) => value.outcomes[status]),
      ]),
    ),
    "",
    "## Cases not run",
    "",
    notRun.length
      ? table(
          ["Case", "Title", "Reason"],
          notRun.map((id) => [
            id,
            caseMap.get(id)?.title ?? id,
            trials.find((trial) => trial.caseId === id)?.reason ??
              (selected.has(id) ? "No executed result" : "Not selected"),
          ]),
        )
      : "None in the supplied catalogue/selection.",
  ];
  if (missingTrials.length)
    lines.push(
      "",
      "### Planned trials without results",
      "",
      table(["Case", "Trial"], missingTrials),
    );
  lines.push(
    "",
    "## Observed cases",
    "",
    summary.byCase.length
      ? table(
          ["Case", "Trials", "Passed", "Failed", "Inconclusive", "Skipped", "Case outcome"],
          summary.byCase.map((entry) => [
            entry.caseId,
            entry.trials,
            ...EXECUTION_STATUSES.map((status) => entry.outcomes[status]),
            entry.outcome,
          ]),
        )
      : "No observed cases.",
  );
  lines.push(
    "",
    "## Trial details",
    "",
    trials.length
      ? table(
          [
            "Case",
            "Trial",
            "Execution",
            "Hard",
            "Semantic",
            "Outcome",
            "Evidence",
            "Fixture seed",
            "Reason",
          ],
          trials.map((trial) => [
            trial.caseId,
            trial.trial,
            trial.executionStatus,
            trial.hardStatus,
            trial.semanticStatus,
            trial.outcome,
            trial.evidenceLevel,
            trial.fixtureSeed ?? run.fixtureSeed,
            trial.reason ?? "—",
          ]),
        )
      : "No trial results.",
  );
  lines.push("", "## Assertion details", "");
  const assertionRows = trials.flatMap((trial) => [
    ...(trial.hardAssertions.length
      ? trial.hardAssertions.map((check) => [
          trial.caseId,
          trial.trial,
          "hard",
          check.id,
          check.passed === null ? "inconclusive" : check.passed ? "passed" : "failed",
          check.detail ?? "—",
        ])
      : [[trial.caseId, trial.trial, "hard", "—", "inconclusive", "No hard assertion evidence"]]),
    ...(trial.semanticChecks.length
      ? trial.semanticChecks.map((check) => [
          trial.caseId,
          trial.trial,
          "semantic",
          check.id,
          check.passed === null ? "not_evaluated" : check.passed ? "passed" : "failed",
          check.detail ?? "—",
        ])
      : [
          [
            trial.caseId,
            trial.trial,
            "semantic",
            "—",
            trial.semanticStatus,
            "No individual semantic checks supplied",
          ],
        ]),
  ]);
  lines.push(
    assertionRows.length
      ? table(["Case", "Trial", "Kind", "Check", "Verdict", "Detail"], assertionRows)
      : "No assertions.",
  );
  lines.push(
    "",
    "## Model identity and actual request usage",
    "",
    "Only recorded usage is summed. Unknown fields remain unknown; known subtotals are not complete totals. Token budgets are configured limits, not measured consumption.",
    "When enabled, the semantic judge is a separate call to the same selected model, not an independent-model or human review. Judge requests count toward usage and budgets and cannot override hard failures; their role is listed separately below.",
    "",
  );
  lines.push(
    trials.length
      ? table(
          [
            "Case",
            "Trial",
            "Configured provider",
            "Requested model",
            "Response model (trial metadata)",
          ],
          trials.map((trial) => {
            const configured = modelIdentity(trial.model ?? run.model);
            return [
              trial.caseId,
              trial.trial,
              configured.provider,
              configured.requested,
              modelIdentity(trial.model).responseModel,
            ];
          }),
        )
      : "No trial model identities supplied.",
    "",
  );
  lines.push(
    table(
      ["Usage", "Total", "Known subtotal", "Requests with unknown value"],
      USAGE_FIELDS.map((field) => [
        field,
        summary.usage[field].total,
        summary.usage[field].knownTotal,
        summary.usage[field].unknownRequests,
      ]),
    ),
  );
  lines.push(
    "",
    `Recorded requests: ${summary.usage.recordedRequests}. Executed live trials without a request log: ${summary.usage.unreportedLiveTrials}.`,
    "",
  );
  const requestRows = trials.flatMap((trial) => {
    const configured = modelIdentity(trial.model ?? run.model);
    return (trial.requests ?? []).map((request, index) => {
      const actual = modelIdentity(request?.model, true);
      return [
        trial.caseId,
        trial.trial,
        request?.id ?? index + 1,
        request?.role,
        actual.provider ?? configured.provider,
        actual.requested ?? configured.requested,
        actual.responseModel,
        ...USAGE_FIELDS.map((field) =>
          numeric(request?.usage?.[field]) ? request.usage[field] : null,
        ),
      ];
    });
  });
  lines.push(
    requestRows.length
      ? table(
          [
            "Case",
            "Trial",
            "Request",
            "Role",
            "Provider",
            "Requested model",
            "Response model",
            ...USAGE_FIELDS,
          ],
          requestRows,
        )
      : "No request records supplied.",
  );
  return `${lines.join("\n")}\n`;
}
