import { join } from "node:path";
import { z } from "zod";
import { mutateJsonFile } from "@cjhyy/code-shell-core/extension";
import { VERDICT_POLICY_SUITE_VERSION } from "./verdict-policy.js";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { DatasetInputSchema, type DatasetInput, type EvalCase } from "./eval-case.js";

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

/** Matches the bounded JSON storage contract; includes all dataset text. */
export const MAX_DATASET_BYTES = 16 * 1024 * 1024;
const datasetTooLarge = (): DatasetIssue => ({
  level: "error",
  code: "dataset_too_large",
  message: `dataset manifest exceeds ${MAX_DATASET_BYTES} bytes`,
});

export function validateDataset(raw: unknown): DatasetValidation {
  try {
    if (Buffer.byteLength(canonicalJson(raw), "utf8") > MAX_DATASET_BYTES) {
      return { ok: false, issues: [datasetTooLarge()] };
    }
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
  if (Buffer.byteLength(canonicalJson(dataset), "utf8") > MAX_DATASET_BYTES) {
    return { ok: false, issues: [datasetTooLarge()] };
  }
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

export interface DatasetManifest {
  schemaVersion: 1;
  datasetHash: string;
  frozenAt: string;
  title: string;
  taskFamily: string;
  verdictPolicySuiteVersion: string;
  cases: EvalCase[];
  caseHashes: Record<string, string>;
  summary: DatasetSummary;
}

export type FreezeResult =
  | { ok: true; created: boolean; path: string; manifest: DatasetManifest }
  | { ok: false; issues: DatasetIssue[] };

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative().max(200);
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetHash: hashSchema,
    frozenAt: z.string().datetime(),
    title: DatasetInputSchema.shape.title,
    taskFamily: DatasetInputSchema.shape.taskFamily,
    verdictPolicySuiteVersion: z.literal(VERDICT_POLICY_SUITE_VERSION),
    cases: DatasetInputSchema.shape.cases,
    caseHashes: z.record(hashSchema),
    summary: z
      .object({
        dev: countSchema,
        holdout: countSchema,
        runnableDev: countSchema,
        runnableHoldout: countSchema,
        sourceGroups: countSchema,
      })
      .strict(),
  })
  .strict();

function contentForHash(dataset: DatasetInput) {
  return {
    schemaVersion: 1 as const,
    title: dataset.title,
    taskFamily: dataset.taskFamily,
    verdictPolicySuiteVersion: VERDICT_POLICY_SUITE_VERSION,
    // Locale collation differs across machines. IDs use stable code-unit order.
    cases: [...dataset.cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

function hashesForCases(cases: EvalCase[]): Record<string, string> {
  // fromEntries creates own data properties even for keys such as constructor.
  return Object.fromEntries(cases.map((item) => [item.id, sha256Hex(canonicalJson(item))]));
}

function readManifest(text: string, datasetHash: string, path: string): DatasetManifest {
  const corrupt = () => new Error(`dataset manifest at ${path} failed integrity validation`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw corrupt();
  const manifest = parsed.data;
  // Defaults must already be persisted. Never silently repair a partial file.
  if (canonicalJson(raw) !== canonicalJson(manifest)) throw corrupt();
  const validation = validateDataset({
    schemaVersion: manifest.schemaVersion,
    title: manifest.title,
    taskFamily: manifest.taskFamily,
    cases: manifest.cases,
  });
  if (!validation.ok || !validation.dataset) throw corrupt();
  const content = contentForHash(validation.dataset);
  if (
    manifest.datasetHash !== datasetHash ||
    sha256Hex(canonicalJson(content)) !== datasetHash ||
    canonicalJson(manifest.cases) !== canonicalJson(content.cases) ||
    canonicalJson(manifest.caseHashes) !== canonicalJson(hashesForCases(content.cases)) ||
    canonicalJson(manifest.summary) !== canonicalJson(validation.summary)
  ) {
    throw corrupt();
  }
  return manifest;
}

/**
 * Freeze content into <labRoot>/datasets/<hash>/manifest.json, under the shared
 * cross-process lock. An existing file must verify completely and is never
 * rewritten. Time is metadata; content hashes do not depend on when it froze.
 */
export function freezeDataset(
  raw: unknown,
  labRootDir: string,
  now: () => Date = () => new Date(),
): FreezeResult {
  const validation = validateDataset(raw);
  if (!validation.ok || !validation.dataset || !validation.summary) {
    return { ok: false, issues: validation.issues };
  }
  const content = contentForHash(validation.dataset);
  const datasetHash = sha256Hex(canonicalJson(content));
  const caseHashes = hashesForCases(content.cases);
  const path = join(labRootDir, "datasets", datasetHash, "manifest.json");
  const summary = validation.summary;
  const createManifest = (frozenAt: string): DatasetManifest => ({
    ...content,
    datasetHash,
    frozenAt,
    caseHashes,
    summary,
  });
  const serialize = (value: DatasetManifest | undefined) => `${JSON.stringify(value, null, 2)}\n`;
  // Timestamp has a fixed ISO width. Check the complete, formatted artifact
  // before the lock creates any directory, without evaluating a new timestamp
  // when the immutable manifest already exists.
  if (
    Buffer.byteLength(serialize(createManifest("9999-12-31T23:59:59.999Z")), "utf8") >
    MAX_DATASET_BYTES
  ) {
    return { ok: false, issues: [datasetTooLarge()] };
  }
  const outcome = mutateJsonFile<
    DatasetManifest | undefined,
    { created: boolean; manifest: DatasetManifest }
  >(path, {
    parse: (text) => (text === undefined ? undefined : readManifest(text, datasetHash, path)),
    serialize,
    maxBytes: MAX_DATASET_BYTES,
    mutation: (current) => {
      if (current !== undefined) return { result: { created: false, manifest: current } };
      const frozenAt = manifestSchema.shape.frozenAt.parse(now().toISOString());
      const manifest = createManifest(frozenAt);
      return { value: manifest, result: { created: true, manifest } };
    },
  });
  if (!outcome) throw new Error(`freezing dataset ${datasetHash} produced no result`);
  return { ok: true, path, ...outcome };
}
