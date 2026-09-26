import { describe, expect, test } from "bun:test";
import { validateDataset } from "./dataset.js";

function evalCase(
  id: string,
  split: "dev" | "holdout",
  group = id,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    version: 1,
    sourceGroupId: group,
    provenance: "synthetic",
    caseRole: "target_failure",
    split,
    input: `Summarize source ${id}`,
    hardAssertions: [{ id: "cites", kind: "contains", value: "[S1]" }],
    readiness: "runnable",
    ...overrides,
  };
}

function dataset(cases: unknown[]) {
  return { schemaVersion: 1, title: "Report sourcing", taskFamily: "report-sourcing", cases };
}

const healthy = () =>
  dataset([
    evalCase("d1", "dev"),
    evalCase("d2", "dev", "d2", { caseRole: "regression" }),
    evalCase("h1", "holdout"),
    evalCase("h2", "holdout"),
    evalCase("h3", "holdout"),
  ]);

const codes = (result: ReturnType<typeof validateDataset>) =>
  result.issues.map((issue) => issue.code).sort();

describe("validateDataset", () => {
  test("accepts a healthy dataset and summarizes it", () => {
    const result = validateDataset(healthy());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({
      dev: 2,
      holdout: 3,
      runnableDev: 2,
      runnableHoldout: 3,
      sourceGroups: 5,
    });
  });

  test("reports schema errors with their path", () => {
    const result = validateDataset(dataset([{ id: "BAD ID" }]));
    expect(result.ok).toBe(false);
    expect(result.issues.every((issue) => issue.code === "schema")).toBe(true);
    expect(result.issues[0]!.message).toContain("cases.0");
  });

  test("rejects duplicate ids and duplicate inputs", () => {
    const input = dataset([
      evalCase("d1", "dev"),
      evalCase("d1", "dev", "g2", { input: "other" }),
      evalCase("d3", "dev", "g3", { input: "Summarize source d1" }),
      evalCase("h1", "holdout"),
    ]);
    expect(codes(validateDataset(input))).toEqual(
      expect.arrayContaining(["duplicate_case_id", "duplicate_input"]),
    );
  });

  test("rejects a source group that appears in both splits", () => {
    const input = dataset([evalCase("d1", "dev", "shared"), evalCase("h1", "holdout", "shared")]);
    expect(codes(validateDataset(input))).toContain("source_group_split_leak");
  });

  test("rejects runnable cases without criteria or with missing evidence", () => {
    const input = dataset([
      evalCase("d1", "dev", "d1", { hardAssertions: [], rubric: [] }),
      evalCase("d2", "dev", "d2", { missingEvidence: ["tool response not recorded"] }),
      evalCase("h1", "holdout"),
    ]);
    expect(codes(validateDataset(input))).toEqual(
      expect.arrayContaining(["runnable_without_criteria", "runnable_with_missing_evidence"]),
    );
  });

  test("requires at least one runnable case per split", () => {
    const input = dataset([
      evalCase("d1", "dev"),
      evalCase("h1", "holdout", "h1", { readiness: "analysis_only" }),
    ]);
    const result = validateDataset(input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("no_runnable_holdout");
  });

  test("warns, without failing, when evidence can only be exploratory", () => {
    const input = dataset([evalCase("d1", "dev"), evalCase("h1", "holdout")]);
    const result = validateDataset(input);
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(["exploratory_only", "no_regression_cases"]);
    expect(result.issues.every((issue) => issue.level === "warning")).toBe(true);
  });
});

describe("dataset boundaries", () => {
  test("keeps unfrozen fixture references out of runnable cases", () => {
    const input = healthy();
    input.cases[0] = evalCase("d1", "dev", "d1", { fixtureRefs: ["source.txt"] });
    const result = validateDataset(input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("unfrozen_fixture_refs");
    expect(
      result.issues.find((issue) => issue.code === "unfrozen_fixture_refs")?.message,
    ).toContain("input");
    input.cases[0] = evalCase("d1", "dev", "d1", {
      readiness: "analysis_only",
      fixtureRefs: ["source.txt"],
    });
    expect(validateDataset(input).ok).toBe(true);
  });

  test.each(["hard", "rubric", "cross"])("rejects duplicate criterion ids: %s", (kind) => {
    const assertion = { id: "shared", kind: "contains", value: "[S1]" };
    const criterion = { id: "shared", text: "Cites sources", requiresHumanGrading: true };
    const input = healthy();
    input.cases[0] = evalCase("d1", "dev", "d1", {
      hardAssertions:
        kind === "hard" ? [assertion, assertion] : kind === "cross" ? [assertion] : [],
      rubric: kind === "rubric" ? [criterion, criterion] : kind === "cross" ? [criterion] : [],
    });
    expect(codes(validateDataset(input))).toContain("duplicate_criterion_id");
  });

  test("bounds text in UTF-8 bytes and supports the exact boundary", () => {
    const input = healthy();
    input.cases[0] = evalCase("d1", "dev", "d1", { input: "é".repeat(32768) });
    expect(validateDataset(input).ok).toBe(true);
    input.cases[0] = evalCase("d1", "dev", "d1", { input: "é".repeat(32769) });
    expect(codes(validateDataset(input))).toContain("schema");
  });

  test("rejects non-JSON assertion values without throwing", () => {
    for (const value of [NaN, Infinity, undefined]) {
      const input = healthy();
      input.cases[0] = evalCase("d1", "dev", "d1", {
        hardAssertions: [{ id: "field", kind: "json_field_equals", path: ["value"], value }],
      });
      expect(validateDataset(input).ok).toBe(false);
    }
  });

  test("rejects unknown fields and more than 200 cases", () => {
    expect(validateDataset({ ...healthy(), execute: true }).ok).toBe(false);
    expect(
      validateDataset(dataset(Array.from({ length: 201 }, (_, i) => evalCase(`d${i}`, "dev")))).ok,
    ).toBe(false);
  });

  test("normalizes defaults without mutating the caller's data", () => {
    const input = healthy();
    const before = JSON.stringify(input);
    const result = validateDataset(input);
    expect(result.dataset?.cases[0]?.fixtureRefs).toEqual([]);
    expect(result.dataset?.cases[0]?.rubric).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
