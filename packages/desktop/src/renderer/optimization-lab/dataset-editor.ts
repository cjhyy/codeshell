import type {
  DatasetInput,
  EvalCase,
  HardAssertion,
  RubricItem,
} from "@cjhyy/code-shell-capability-optimization-lab";

// Optional defaulted fields stay absent until edited. The form must not silently
// normalize a user's JSON, especially when switching between editing modes.
type DefaultedCaseKey = "fixtureRefs" | "rubric" | "hardAssertions" | "missingEvidence";
export type EditableCase = Omit<EvalCase, DefaultedCaseKey> &
  Partial<Pick<EvalCase, DefaultedCaseKey>>;
export type EditableDataset = Omit<DatasetInput, "cases"> & { cases: EditableCase[] };
export type EditorParseResult =
  | { ok: true; dataset: EditableDataset }
  | { ok: false; reason: "json" | "shape" | "unknown" | "size"; path: string };

const DATASET_FIELDS = ["schemaVersion", "title", "taskFamily", "cases"];
const CASE_FIELDS = [
  "id",
  "version",
  "sourceGroupId",
  "provenance",
  "caseRole",
  "split",
  "input",
  "fixtureRefs",
  "expected",
  "rubric",
  "hardAssertions",
  "readiness",
  "missingEvidence",
];
const MAX_EDITOR_BYTES = 16 * 1024 * 1024;

class UnsupportedShape extends Error {
  constructor(
    readonly path: string,
    readonly reason: "shape" | "unknown" = "shape",
  ) {
    super(path);
  }
}
function object(value: unknown, fields: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnsupportedShape(path);
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record))
    if (!fields.includes(field)) throw new UnsupportedShape(`${path}.${field}`, "unknown");
  return record;
}
function requireType(condition: boolean, path: string): asserts condition {
  if (!condition) throw new UnsupportedShape(path);
}
function strings(value: unknown, path: string, limit: number): void {
  requireType(Array.isArray(value), path);
  requireType(value.length <= limit, path);
  value.forEach((item, index) => requireType(typeof item === "string", `${path}.${index}`));
}
function assertion(value: unknown, path: string): void {
  const item = object(value, ["id", "kind", "value", "path"], path);
  requireType(typeof item.id === "string", `${path}.id`);
  if (item.kind === "contains" || item.kind === "not_contains") {
    requireType(!Object.hasOwn(item, "path"), `${path}.path`);
    requireType(typeof item.value === "string", `${path}.value`);
  } else {
    requireType(item.kind === "json_field_equals", `${path}.kind`);
    strings(item.path, `${path}.path`, 8);
    requireType(
      item.value === null ||
        typeof item.value === "string" ||
        typeof item.value === "boolean" ||
        (typeof item.value === "number" && Number.isFinite(item.value)),
      `${path}.value`,
    );
  }
}

/** Shape checking only: the worker remains authoritative for dataset validity. */
export function parseEditableDataset(text: string): EditorParseResult {
  if (new TextEncoder().encode(text).byteLength > MAX_EDITOR_BYTES)
    return { ok: false, reason: "size", path: "$" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json", path: "$" };
  }
  try {
    const dataset = object(raw, DATASET_FIELDS, "$");
    requireType(dataset.schemaVersion === 1, "$.schemaVersion");
    requireType(typeof dataset.title === "string", "$.title");
    requireType(typeof dataset.taskFamily === "string", "$.taskFamily");
    requireType(Array.isArray(dataset.cases), "$.cases");
    requireType(dataset.cases.length <= 200, "$.cases");
    dataset.cases.forEach((rawCase, index) => {
      const path = `$.cases.${index}`;
      const item = object(rawCase, CASE_FIELDS, path);
      for (const key of ["id", "sourceGroupId", "input"])
        requireType(typeof item[key] === "string", `${path}.${key}`);
      requireType(
        typeof item.version === "number" && Number.isFinite(item.version),
        `${path}.version`,
      );
      requireType(["real", "synthetic"].includes(String(item.provenance)), `${path}.provenance`);
      requireType(
        ["target_failure", "regression"].includes(String(item.caseRole)),
        `${path}.caseRole`,
      );
      requireType(["dev", "holdout"].includes(String(item.split)), `${path}.split`);
      requireType(
        ["analysis_only", "runnable"].includes(String(item.readiness)),
        `${path}.readiness`,
      );
      if (Object.hasOwn(item, "expected"))
        requireType(typeof item.expected === "string", `${path}.expected`);
      for (const key of ["fixtureRefs", "missingEvidence"])
        if (Object.hasOwn(item, key)) strings(item[key], `${path}.${key}`, 32);
      if (Object.hasOwn(item, "rubric")) {
        requireType(Array.isArray(item.rubric), `${path}.rubric`);
        requireType(item.rubric.length <= 16, `${path}.rubric`);
        item.rubric.forEach((value, rubricIndex) => {
          const rubricPath = `${path}.rubric.${rubricIndex}`;
          const rubric = object(value, ["id", "text", "requiresHumanGrading"], rubricPath);
          requireType(typeof rubric.id === "string", `${rubricPath}.id`);
          requireType(typeof rubric.text === "string", `${rubricPath}.text`);
          requireType(
            typeof rubric.requiresHumanGrading === "boolean",
            `${rubricPath}.requiresHumanGrading`,
          );
        });
      }
      if (Object.hasOwn(item, "hardAssertions")) {
        requireType(Array.isArray(item.hardAssertions), `${path}.hardAssertions`);
        requireType(item.hardAssertions.length <= 16, `${path}.hardAssertions`);
        item.hardAssertions.forEach((value, assertionIndex) =>
          assertion(value, `${path}.hardAssertions.${assertionIndex}`),
        );
      }
    });
    return { ok: true, dataset: raw as EditableDataset };
  } catch (error) {
    if (error instanceof UnsupportedShape)
      return { ok: false, reason: error.reason, path: error.path };
    throw error;
  }
}

export function serializeEditableDataset(dataset: EditableDataset): string {
  return JSON.stringify(dataset, null, 2);
}

function unusedId(existing: string[], base: string): string {
  const ids = new Set(existing);
  const prefix = base.slice(0, 53);
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

export function createEditableCase(dataset: EditableDataset): EditableCase {
  return {
    id: unusedId(
      dataset.cases.map((item) => item.id),
      "case",
    ),
    version: 1,
    sourceGroupId: unusedId(
      dataset.cases.map((item) => item.sourceGroupId),
      "source",
    ),
    provenance: "synthetic",
    caseRole: "target_failure",
    split: "dev",
    input: "",
    readiness: "analysis_only",
    fixtureRefs: [],
    rubric: [],
    hardAssertions: [],
    missingEvidence: [],
  };
}

/** Copies remain in the same source group and split to avoid invented independence. */
export function duplicateEditableCase(dataset: EditableDataset, index: number): EditableCase {
  const source = dataset.cases[index];
  if (!source) throw new Error("Unknown case");
  const copied = structuredClone(source);
  const safeBase = /^[a-z0-9][a-z0-9._-]*$/.test(source.id) ? source.id : "case";
  copied.id = unusedId(
    dataset.cases.map((item) => item.id),
    `${safeBase}-copy`,
  );
  return copied;
}

export function newRubric(item: EditableCase): RubricItem {
  return {
    id: unusedId(
      [...(item.rubric ?? []), ...(item.hardAssertions ?? [])].map((rule) => rule.id),
      "quality",
    ),
    text: "",
    requiresHumanGrading: true,
  };
}
export function newAssertion(item: EditableCase): HardAssertion {
  return {
    id: unusedId(
      [...(item.rubric ?? []), ...(item.hardAssertions ?? [])].map((rule) => rule.id),
      "assertion",
    ),
    kind: "contains",
    value: "",
  };
}
export function changeAssertionKind(
  item: HardAssertion,
  kind: HardAssertion["kind"],
): HardAssertion {
  if (kind === item.kind) return item;
  return kind === "json_field_equals"
    ? { id: item.id, kind, path: ["field"], value: item.value }
    : { id: item.id, kind, value: item.value === null ? "null" : String(item.value) };
}

export function summarizeEditableDataset(dataset: EditableDataset) {
  const runnableHoldout = dataset.cases.filter(
    (item) => item.split === "holdout" && item.readiness === "runnable",
  );
  return {
    dev: dataset.cases.filter((item) => item.split === "dev").length,
    holdout: dataset.cases.filter((item) => item.split === "holdout").length,
    sourceGroups: new Set(dataset.cases.map((item) => item.sourceGroupId)).size,
    runnableHoldoutGroups: new Set(runnableHoldout.map((item) => item.sourceGroupId)).size,
  };
}
