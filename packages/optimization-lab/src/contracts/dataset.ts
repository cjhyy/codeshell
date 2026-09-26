import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { DatasetInputSchema, type DatasetInput } from "./eval-case.js";

export interface DatasetIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  caseId?: string;
}

export interface DatasetSummary {
  dev: number;
  holdout: number;
  runnableDev: number;
  runnableHoldout: number;
  sourceGroups: number;
}

export interface DatasetValidation {
  ok: boolean;
  issues: DatasetIssue[];
  dataset?: DatasetInput;
  summary?: DatasetSummary;
}

/** Holdout source groups below this give an exploratory report, never "verified". */
export const MIN_HOLDOUT_SOURCE_GROUPS = 3;

export function validateDataset(raw: unknown): DatasetValidation {
  try {
    canonicalJson(raw);
  } catch (error) {
    return {
      ok: false,
      issues: [{ level: "error", code: "schema", message: String(error) }],
    };
  }
  const parsed = DatasetInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        level: "error" as const,
        code: "schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    };
  }
  const dataset = parsed.data;
  const issues: DatasetIssue[] = [];
  const error = (code: string, message: string, caseId?: string) =>
    issues.push({ level: "error", code, message, caseId });
  const warning = (code: string, message: string) =>
    issues.push({ level: "warning", code, message });

  const ids = new Set<string>();
  const inputs = new Map<string, string>();
  const groupSplits = new Map<string, Set<string>>();
  for (const item of dataset.cases) {
    if (ids.has(item.id))
      error("duplicate_case_id", `case id ${item.id} appears more than once`, item.id);
    ids.add(item.id);

    const inputHash = sha256Hex(
      canonicalJson({ input: item.input, fixtureRefs: item.fixtureRefs }),
    );
    const first = inputs.get(inputHash);
    if (first !== undefined) {
      error("duplicate_input", `case ${item.id} repeats the input of ${first}`, item.id);
    } else {
      inputs.set(inputHash, item.id);
    }

    // Each criterion has one stable identity, including across hard and human
    // grading. A later grading record must never ambiguously target two rules.
    const criterionIds = new Set<string>();
    for (const criterion of [...item.hardAssertions, ...item.rubric]) {
      if (criterionIds.has(criterion.id)) {
        error(
          "duplicate_criterion_id",
          `case ${item.id} repeats criterion ${criterion.id}`,
          item.id,
        );
      }
      criterionIds.add(criterion.id);
    }
    // P0 freezes text only. A path or URL does not freeze its referenced bytes.
    if (item.readiness === "runnable" && item.fixtureRefs.length > 0) {
      error(
        "unfrozen_fixture_refs",
        `case ${item.id} references unfrozen fixtures; inline the material in input`,
        item.id,
      );
    }

    const splits = groupSplits.get(item.sourceGroupId) ?? new Set<string>();
    splits.add(item.split);
    groupSplits.set(item.sourceGroupId, splits);

    if (
      item.readiness === "runnable" &&
      item.hardAssertions.length === 0 &&
      item.rubric.length === 0
    ) {
      error(
        "runnable_without_criteria",
        `runnable case ${item.id} has no assertion or rubric`,
        item.id,
      );
    }
    if (item.readiness === "runnable" && item.missingEvidence.length > 0) {
      error(
        "runnable_with_missing_evidence",
        `case ${item.id} lists missing evidence; mark it analysis_only`,
        item.id,
      );
    }
  }
  for (const [group, splits] of groupSplits) {
    if (splits.size > 1)
      error("source_group_split_leak", `source group ${group} appears in both dev and holdout`);
  }

  const dev = dataset.cases.filter((item) => item.split === "dev");
  const holdout = dataset.cases.filter((item) => item.split === "holdout");
  const runnableDev = dev.filter((item) => item.readiness === "runnable").length;
  const runnableHoldout = holdout.filter((item) => item.readiness === "runnable").length;
  if (runnableDev === 0) error("no_runnable_dev", "the dev split has no runnable case");
  if (runnableHoldout === 0) error("no_runnable_holdout", "the holdout split has no runnable case");

  const holdoutGroups = new Set(
    holdout.filter((item) => item.readiness === "runnable").map((item) => item.sourceGroupId),
  );
  if (runnableHoldout > 0 && holdoutGroups.size < MIN_HOLDOUT_SOURCE_GROUPS) {
    warning(
      "exploratory_only",
      `holdout has ${holdoutGroups.size} independent source group(s); results can only be exploratory`,
    );
  }
  if (!dataset.cases.some((item) => item.caseRole === "regression")) {
    warning("no_regression_cases", "no regression case covers tasks that already succeed");
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    dataset,
    summary: {
      dev: dev.length,
      holdout: holdout.length,
      runnableDev,
      runnableHoldout,
      sourceGroups: groupSplits.size,
    },
  };
}
