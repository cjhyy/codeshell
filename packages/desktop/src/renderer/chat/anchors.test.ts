import { describe, expect, test } from "bun:test";
import {
  encodeAnchorsForWire,
  extractAnnotations,
  type Anchor,
} from "./anchors";

const sampleAnchors: Anchor[] = [
  {
    id: "anchor-1",
    kind: "file",
    label: "engine.ts:42",
    locator: { 文件: "engine.ts", 行: "42", 代码: "const x = 1;" },
    comment: "这里有 bug",
  },
  {
    id: "anchor-2",
    kind: "browser",
    label: "button.primary",
    locator: { URL: "http://x", 选择器: "button.primary" },
    comment: "颜色不对",
  },
];

describe("extractAnnotations", () => {
  test("returns null block and original text when no annotations present", () => {
    const r = extractAnnotations("just a normal message");
    expect(r.block).toBeNull();
    expect(r.text).toBe("just a normal message");
  });

  test("splits the annotations block out of the user prose", () => {
    const wire = encodeAnchorsForWire("帮我改一下", sampleAnchors);
    const r = extractAnnotations(wire);
    expect(r.block).not.toBeNull();
    // The user's own prose survives, the raw XML tags do not.
    expect(r.text).toBe("帮我改一下");
    expect(r.text).not.toContain("codeshell-annotations");
  });

  test("parses each entry's kind label, locator lines, and comment", () => {
    const wire = encodeAnchorsForWire("", sampleAnchors);
    const r = extractAnnotations(wire);
    expect(r.block).not.toBeNull();
    expect(r.block!.header).toContain("界面上标注");
    expect(r.block!.entries).toHaveLength(2);

    const [first, second] = r.block!.entries;
    expect(first.kindLabel).toBe("文件");
    expect(first.label).toBe("engine.ts:42");
    expect(first.comment).toBe("这里有 bug");
    expect(first.locator).toEqual([
      { key: "文件", value: "engine.ts" },
      { key: "行", value: "42" },
      { key: "代码", value: "const x = 1;" },
    ]);

    expect(second.kindLabel).toBe("浏览器");
    expect(second.label).toBe("button.primary");
    expect(second.comment).toBe("颜色不对");
  });

  test("annotations block when there is no trailing prose", () => {
    const wire = encodeAnchorsForWire("", sampleAnchors);
    const r = extractAnnotations(wire);
    expect(r.text).toBe("");
    expect(r.block!.entries).toHaveLength(2);
  });

  test("round-trips a single anchor", () => {
    const one: Anchor[] = [sampleAnchors[0]];
    const wire = encodeAnchorsForWire("看这里", one);
    const r = extractAnnotations(wire);
    expect(r.block!.entries).toHaveLength(1);
    expect(r.text).toBe("看这里");
  });
});
