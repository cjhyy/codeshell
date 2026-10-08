import { describe, expect, test } from "bun:test";
import {
  changeAssertionKind,
  createEditableCase,
  duplicateEditableCase,
  newAssertion,
  newRubric,
  parseEditableDataset,
  serializeEditableDataset,
  summarizeEditableDataset,
  type EditableDataset,
} from "./dataset-editor";

function dataset(): EditableDataset {
  return {
    schemaVersion: 1,
    title: "Reviewed tasks",
    taskFamily: "summarize",
    cases: [
      {
        id: "first",
        version: 1,
        sourceGroupId: "source-1",
        provenance: "real",
        caseRole: "target_failure",
        split: "dev",
        input: "Input",
        readiness: "analysis_only",
      },
    ],
  };
}
describe("Optimization Lab dataset form representation", () => {
  test("preserves absent defaults and absent vs explicitly empty expected", () => {
    const raw = dataset();
    const parsed = parseEditableDataset(JSON.stringify(raw));
    expect(parsed).toEqual({ ok: true, dataset: raw });
    if (!parsed.ok) throw new Error("Unexpected shape");
    parsed.dataset.title = "Changed";
    const item = JSON.parse(serializeEditableDataset(parsed.dataset)).cases[0];
    for (const key of ["expected", "rubric", "hardAssertions", "fixtureRefs", "missingEvidence"])
      expect(Object.hasOwn(item, key)).toBe(false);
    raw.cases[0]!.expected = "";
    expect(parseEditableDataset(JSON.stringify(raw))).toEqual({ ok: true, dataset: raw });
  });
  test("round-trips every assertion scalar and path segment without splitting text", () => {
    const raw = dataset();
    raw.cases[0]!.fixtureRefs = ["a\nb", "c"];
    raw.cases[0]!.missingEvidence = ["Line 1\nLine 2"];
    raw.cases[0]!.hardAssertions = [
      { id: "contains", kind: "contains", value: "yes" },
      { id: "excluded", kind: "not_contains", value: "no" },
      ...["", "1", 1.5, true, false, null].map((value, index) => ({
        id: `json-${index}`,
        kind: "json_field_equals" as const,
        path: ["nested", "1"],
        value,
      })),
    ];
    raw.cases[0]!.rubric = [{ id: "human", text: "Faithful", requiresHumanGrading: false }];
    const parsed = parseEditableDataset(serializeEditableDataset(raw));
    expect(parsed).toEqual({ ok: true, dataset: raw });
  });
  test("does not normalize away unsupported or unknown fields at any depth", () => {
    const variants: Array<[unknown, string]> = [
      [{ ...dataset(), metadata: "future" }, "$.metadata"],
      [{ ...dataset(), cases: [{ ...dataset().cases[0], future: 2 }] }, "$.cases.0.future"],
      [
        {
          ...dataset(),
          cases: [
            {
              ...dataset().cases[0],
              rubric: [{ id: "r", text: "x", requiresHumanGrading: true, future: 2 }],
            },
          ],
        },
        "$.cases.0.rubric.0.future",
      ],
      [
        {
          ...dataset(),
          cases: [
            {
              ...dataset().cases[0],
              hardAssertions: [{ id: "r", kind: "contains", value: "x", future: 2 }],
            },
          ],
        },
        "$.cases.0.hardAssertions.0.future",
      ],
    ];
    for (const [raw, path] of variants)
      expect(parseEditableDataset(JSON.stringify(raw))).toEqual({
        ok: false,
        reason: "unknown",
        path,
      });
    expect(parseEditableDataset("{broken")).toEqual({ ok: false, reason: "json", path: "$" });
    expect(
      parseEditableDataset(
        JSON.stringify({ ...dataset(), cases: [{ ...dataset().cases[0], expected: null }] }),
      ),
    ).toEqual({ ok: false, reason: "shape", path: "$.cases.0.expected" });
  });
  test("accepts editable invalid values for authoritative worker validation", () => {
    const raw = dataset();
    raw.title = "";
    raw.cases[0]!.id = "INVALID ID";
    raw.cases[0]!.version = 0;
    raw.cases[0]!.readiness = "runnable";
    expect(parseEditableDataset(JSON.stringify(raw))).toEqual({ ok: true, dataset: raw });
  });
  test("bounds mounted form collections without rewriting oversized JSON", () => {
    const raw = dataset();
    raw.cases = Array.from({ length: 201 }, () => ({ ...raw.cases[0]! }));
    expect(parseEditableDataset(JSON.stringify(raw))).toEqual({
      ok: false,
      reason: "shape",
      path: "$.cases",
    });
  });
  test("new cases start analysis-only; copies retain group, split and independent arrays", () => {
    const raw = dataset();
    raw.cases[0]!.split = "holdout";
    raw.cases[0]!.rubric = [{ id: "quality-1", text: "Score", requiresHumanGrading: true }];
    raw.cases[0]!.hardAssertions = [{ id: "assertion-1", kind: "contains", value: "yes" }];
    const added = createEditableCase(raw);
    expect(added).toMatchObject({
      id: "case-1",
      sourceGroupId: "source-2",
      provenance: "synthetic",
      readiness: "analysis_only",
    });
    const copied = duplicateEditableCase(raw, 0);
    expect(copied).toMatchObject({
      id: "first-copy-1",
      sourceGroupId: "source-1",
      split: "holdout",
    });
    copied.rubric![0]!.text = "Changed";
    expect(raw.cases[0]!.rubric![0]!.text).toBe("Score");
    raw.cases.push(copied);
    expect(duplicateEditableCase(raw, 0).id).toBe("first-copy-2");
    expect(newRubric(raw.cases[0]!)).toMatchObject({ id: "quality-2", requiresHumanGrading: true });
    expect(newAssertion(raw.cases[0]!).id).toBe("assertion-2");
    expect(summarizeEditableDataset(raw)).toMatchObject({ holdout: 2, sourceGroups: 1 });
  });
  test("assertion kind changes are explicit and retain the criterion identity", () => {
    expect(
      changeAssertionKind({ id: "rule", kind: "contains", value: "true" }, "json_field_equals"),
    ).toEqual({ id: "rule", kind: "json_field_equals", path: ["field"], value: "true" });
    expect(
      changeAssertionKind(
        { id: "rule", kind: "json_field_equals", path: ["field"], value: false },
        "not_contains",
      ),
    ).toEqual({ id: "rule", kind: "not_contains", value: "false" });
  });
});
