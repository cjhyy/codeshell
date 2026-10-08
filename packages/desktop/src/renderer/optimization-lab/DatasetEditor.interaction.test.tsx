import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DatasetValidation } from "@cjhyy/code-shell-capability-optimization-lab";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DatasetEditor } from "./DatasetEditor";
import type { EditableDataset } from "./dataset-editor";

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
}
function initial(): EditableDataset {
  return {
    schemaVersion: 1,
    title: "Dataset",
    taskFamily: "text",
    cases: [
      {
        id: "dev",
        version: 1,
        sourceGroupId: "one",
        provenance: "real",
        caseRole: "target_failure",
        split: "dev",
        input: "Input",
        readiness: "runnable",
      },
      {
        id: "holdout",
        version: 1,
        sourceGroupId: "two",
        provenance: "synthetic",
        caseRole: "regression",
        split: "holdout",
        input: "Other input",
        readiness: "runnable",
      },
    ],
  };
}
describe("Optimization Lab dataset editor", () => {
  let root: Root,
    container: HTMLElement,
    value: string,
    changes: string[],
    validation: DatasetValidation | null;
  let disabled: boolean;
  const nodes = () => descendants(container);
  const find = (id: string) =>
    nodes().find((node) => props(node)["data-testid"] === `optimization-lab-${id}`);
  async function render() {
    await act(async () => {
      root.render(
        <DatasetEditor
          value={value}
          validation={validation}
          disabled={disabled}
          onChange={(text) => {
            value = text;
            changes.push(text);
          }}
        />,
      );
      await flushMicrotasks();
    });
  }
  async function click(id: string) {
    await act(async () => {
      props(find(id)!).onClick();
      await flushMicrotasks();
    });
    await render();
  }
  async function change(id: string, next: string | boolean) {
    await act(async () => {
      props(find(id)!).onChange({ target: { value: String(next), checked: next } });
      await flushMicrotasks();
    });
    await render();
  }
  beforeEach(() => {
    ensureMiniDom();
    value = JSON.stringify(initial());
    changes = [];
    validation = null;
    disabled = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
  });
  test("defaults to one expanded case, switches views without changing the JSON", async () => {
    const original = value;
    await render();
    expect(find("dataset-title")).toBeDefined();
    expect(find("case-0-input")).toBeDefined();
    expect(find("case-1-input")).toBeUndefined();
    expect(find("dataset-exploratory")).toBeDefined();
    await click("dataset-json");
    expect(props(find("dataset")!).value).toBe(original);
    await click("dataset-form");
    expect(changes).toHaveLength(0);
    await change("dataset-title", "Reviewed");
    expect(JSON.parse(value).title).toBe("Reviewed");
    expect(Object.hasOwn(JSON.parse(value).cases[0], "expected")).toBe(false);
  });
  test("unknown and unsupported JSON stays editable without silent data loss", async () => {
    value = '{ "schemaVersion": 1, "title": "x", "taskFamily": "text", "cases": [], "future": 2 }';
    const original = value;
    await render();
    expect(find("dataset-unsupported")).toBeDefined();
    expect(props(find("dataset")!).value).toBe(original);
    expect(find("dataset-title")).toBeUndefined();
    await click("dataset-form");
    expect(value).toBe(original);
    expect(changes).toHaveLength(0);
    await change("dataset", JSON.stringify(initial()));
    expect(find("dataset-title")).toBeDefined();
  });
  test("optional expected toggles preserve absent versus empty and edits are immediate", async () => {
    await render();
    await change("case-0-expected-enabled", true);
    expect(JSON.parse(value).cases[0].expected).toBe("");
    await change("case-0-expected", "Expected result");
    expect(JSON.parse(value).cases[0].expected).toBe("Expected result");
    await change("case-0-expected-enabled", false);
    expect(Object.hasOwn(JSON.parse(value).cases[0], "expected")).toBe(false);
    await change("case-0-input", "Changed input");
    expect(JSON.parse(changes.at(-1)!).cases[0].input).toBe("Changed input");
  });
  test("case copy retains source group, new case is independent, and both are editable", async () => {
    await render();
    await click("case-0-duplicate");
    expect(JSON.parse(value).cases[2]).toMatchObject({
      id: "dev-copy-1",
      sourceGroupId: "one",
      split: "dev",
    });
    expect(find("case-2-input")).toBeDefined();
    await click("case-2-remove");
    await click("case-add");
    expect(JSON.parse(value).cases[2]).toMatchObject({
      id: "case-1",
      sourceGroupId: "source-1",
      readiness: "analysis_only",
    });
    await change("case-2-input", "New input");
    expect(JSON.parse(value).cases[2].input).toBe("New input");
  });
  test("all rubric, hard assertion scalar types and path segments remain distinct", async () => {
    await render();
    await click("case-0-rubric-add");
    await change("case-0-rubric-0-text", "Faithful");
    await change("case-0-rubric-0-human", false);
    expect(JSON.parse(value).cases[0].rubric[0]).toMatchObject({
      text: "Faithful",
      requiresHumanGrading: false,
    });
    await click("case-0-assertion-add");
    await change("case-0-assertion-0-kind", "not_contains");
    await change("case-0-assertion-0-value", "secret");
    expect(JSON.parse(value).cases[0].hardAssertions[0]).toMatchObject({
      kind: "not_contains",
      value: "secret",
    });
    await change("case-0-assertion-0-kind", "json_field_equals");
    await change("case-0-assertion-0-path-0", "result");
    await click("case-0-assertion-0-path-add");
    await change("case-0-assertion-0-path-1", "score");
    await change("case-0-assertion-0-value-type", "number");
    await change("case-0-assertion-0-value", "1.5");
    expect(JSON.parse(value).cases[0].hardAssertions[0]).toMatchObject({
      path: ["result", "score"],
      value: 1.5,
    });
    await change("case-0-assertion-0-value-type", "boolean");
    await change("case-0-assertion-0-value", "true");
    expect(JSON.parse(value).cases[0].hardAssertions[0].value).toBe(true);
    await change("case-0-assertion-0-value-type", "null");
    expect(JSON.parse(value).cases[0].hardAssertions[0].value).toBeNull();
    await change("case-0-assertion-0-value-type", "string");
    await change("case-0-assertion-0-value", "true");
    expect(JSON.parse(value).cases[0].hardAssertions[0].value).toBe("true");
    await click("case-0-assertion-0-remove");
    await click("case-0-rubric-0-remove");
    expect(JSON.parse(value).cases[0]).toMatchObject({ rubric: [], hardAssertions: [] });
  });
  test("fixture and missing-evidence rows preserve newlines and do not auto-enable runs", async () => {
    await render();
    await change("case-0-readiness", "analysis_only");
    await click("case-0-fixtureRefs-add");
    await change("case-0-fixtureRefs-0", "first\nsecond");
    await click("case-0-missingEvidence-add");
    await change("case-0-missingEvidence-0", "Need source");
    expect(JSON.parse(value).cases[0]).toMatchObject({
      fixtureRefs: ["first\nsecond"],
      missingEvidence: ["Need source"],
      readiness: "analysis_only",
    });
    await click("case-0-fixtureRefs-0-remove");
    expect(JSON.parse(value).cases[0].fixtureRefs).toEqual([]);
  });
  test("fields permitting line breaks use textareas and preserve imported multiline values", async () => {
    const imported = initial();
    imported.title = "Title\ncontinued";
    imported.taskFamily = "Family\ncontinued";
    imported.cases[0]!.sourceGroupId = "Group\ncontinued";
    imported.cases[0]!.fixtureRefs = ["Reference\ncontinued"];
    imported.cases[0]!.missingEvidence = ["Evidence\ncontinued"];
    imported.cases[0]!.hardAssertions = [
      {
        id: "json",
        kind: "json_field_equals",
        path: ["Field\ncontinued"],
        value: null,
      },
    ];
    value = JSON.stringify(imported);
    await render();
    const fields = [
      ["dataset-title", imported.title],
      ["dataset-task-family", imported.taskFamily],
      ["case-0-sourceGroupId", imported.cases[0]!.sourceGroupId],
      ["case-0-fixtureRefs-0", imported.cases[0]!.fixtureRefs[0]],
      ["case-0-missingEvidence-0", imported.cases[0]!.missingEvidence[0]],
      ["case-0-assertion-0-path-0", imported.cases[0]!.hardAssertions[0]!.path[0]],
    ];
    for (const [id, text] of fields) {
      expect(find(id!)!.tagName).toBe("TEXTAREA");
      expect(props(find(id!)!).value).toBe(text);
    }
    await change("dataset-title", "Edited\ncontinued");
    expect(JSON.parse(value)).toEqual({ ...imported, title: "Edited\ncontinued" });
  });
  test("worker issues remain visible on each case and raw JSON, including unmatched issues", async () => {
    validation = {
      ok: false,
      issues: [
        { level: "error", code: "criteria", caseId: "dev", message: "Missing criterion" },
        { level: "error", code: "schema", message: "cases.1.input: too long" },
        { level: "warning", code: "other", caseId: "missing-case", message: "Retained issue" },
        { level: "warning", code: "exploratory", message: "Exploratory only" },
      ],
    };
    await render();
    expect(find("case-0-issues")).toBeDefined();
    expect(find("dataset-issues")).toBeDefined();
    await click("dataset-json");
    const list = find("dataset-issues")!;
    expect(descendants(list).filter((node) => node.tagName === "LI")).toHaveLength(4);
  });
  test("disabled editing reaches the form fieldset and raw JSON", async () => {
    disabled = true;
    await render();
    expect(props(find("dataset-fields")!).disabled).toBe(true);
    expect(props(find("dataset-json")!).disabled).toBe(true);
    value = "broken";
    await render();
    expect(props(find("dataset")!).disabled).toBe(true);
  });
});
