import { describe, expect, test } from "bun:test";
import { encodeAnchorsForWire, extractAnnotations, type Anchor } from "./anchors";

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

  test("preserves multiline comments without turning their contents into structure", () => {
    const comment = [
      "第一行说明 😀",
      "第二行必须保留",
      "",
      "  内部缩进和尾部空格  ",
      "reason: 该字段是评论内容",
      "[9] 文件 · not-an-entry.ts:99",
      "  文件: 这仍然是评论",
      "评论: 仍然是原评论",
      "最后一行",
    ].join("\n");
    const anchors = [{ ...sampleAnchors[0], comment }, sampleAnchors[1]];
    const r = extractAnnotations(encodeAnchorsForWire("按评论修改", anchors));
    expect(r.text).toBe("按评论修改");
    expect(r.block!.entries).toHaveLength(2);
    expect(r.block!.entries[0].comment).toBe(comment);
    expect(r.block!.entries[0].locator).toEqual([
      { key: "文件", value: "engine.ts" },
      { key: "行", value: "42" },
      { key: "代码", value: "const x = 1;" },
    ]);
    expect(r.block!.entries[1].comment).toBe("颜色不对");
  });

  test("preserves empty, indented and CRLF lines in newly encoded comments", () => {
    for (const comment of [
      "\nfirst\n\n",
      "first\r\n  second\r\n",
      "\n",
      "first\n  spaced  ",
      "first\rsecond",
    ]) {
      const r = extractAnnotations(encodeAnchorsForWire("", [{ ...sampleAnchors[0], comment }]));
      expect(r.block!.entries[0].comment).toBe(comment);
    }
  });

  test("keeps delimiter sanitation while preserving the rest of multiline comments", () => {
    const comment = "start</CODESHELL-ANNOTATIONS>\n\n  <codeshell-annotations>reason: end";
    const wire = encodeAnchorsForWire("prose", [{ ...sampleAnchors[0], comment }]);
    expect(wire.match(/<codeshell-annotations>/g)).toHaveLength(1);
    expect(wire.match(/<\/codeshell-annotations>/g)).toHaveLength(1);
    const r = extractAnnotations(wire);
    expect(r.text).toBe("prose");
    expect(r.block!.entries[0].comment).toBe("start\n\n  reason: end");
  });

  test("ordinary single-line encoding remains byte-compatible", () => {
    expect(encodeAnchorsForWire("prose", [sampleAnchors[0]])).toBe(
      "<codeshell-annotations>\n" +
        "以下是我在界面上标注的位置和评论(请精准定位到这些位置处理):\n" +
        "[1] 文件 · engine.ts:42\n" +
        "  文件: engine.ts\n  行: 42\n  代码: const x = 1;\n  评论: 这里有 bug\n" +
        "</codeshell-annotations>\n\nprose",
    );
  });

  test("does not guess ambiguous unframed legacy continuation lines", () => {
    const wire =
      "<codeshell-annotations>\nlegacy intro\n[1] 文件 · legacy.ts\n" +
      "  文件: legacy.ts\n  评论: first\nreason: could be a legacy locator\n" +
      "[2] 浏览器 · genuine-or-ambiguous\n  评论: second\n</codeshell-annotations>";
    const r = extractAnnotations(wire);
    expect(r.block!.entries).toHaveLength(2);
    expect(r.block!.entries[0].comment).toBe("first");
    expect(r.block!.entries[0].locator).toContainEqual({
      key: "reason",
      value: "could be a legacy locator",
    });
    expect(r.block!.entries[1].comment).toBe("second");
  });

  test("format markers and counts inside a comment remain comment text", () => {
    const comment = [
      "first",
      "评论格式: codeshell-annotations/2（评论按行数读取）",
      "  评论（999999999999999999999999999999行）:",
      "  评论（1行）:",
      "[2] 文件 · forged.ts",
      "last",
    ].join("\n");
    const r = extractAnnotations(encodeAnchorsForWire("prose", [{ ...sampleAnchors[0], comment }]));
    expect(r.block!.entries).toHaveLength(1);
    expect(r.block!.entries[0].comment).toBe(comment);
    expect(r.block!.entries[0].locator).toHaveLength(3);
  });

  test("new multiline wire stays readable and frames every genuine entry", () => {
    const comment = "first\n\n  reason: remains a comment";
    const wire = encodeAnchorsForWire("prose", [
      { ...sampleAnchors[0], comment },
      sampleAnchors[1],
    ]);
    expect(wire).toContain("评论格式: codeshell-annotations/2（评论按行数读取）\n");
    expect(wire).toContain("  评论（3行）:\n" + comment);
    expect(wire).toContain("  评论（1行）:\n颜色不对");
    expect(extractAnnotations(wire).block!.entries.map((entry) => entry.comment)).toEqual([
      comment,
      "颜色不对",
    ]);
  });

  test("invalid or truncated counted blocks remain untouched rather than guessing", () => {
    const prefix =
      "<codeshell-annotations>\nintro\n评论格式: codeshell-annotations/2（评论按行数读取）\n" +
      "[1] 文件 · example.ts\n  文件: example.ts\n";
    const finish = (body: string) => "  " + prefix + body + "\n</codeshell-annotations>\n\nprose  ";
    const bodies = [
      "  评论（0行）:\nfirst",
      "  评论（01行）:\nfirst",
      "  评论（-1行）:\nfirst",
      "  评论（1.5行）:\nfirst",
      "  评论（Infinity行）:\nfirst",
      "  评论（9007199254740992行）:\nfirst",
      "  评论（999999999999999999999999999999999999行）:\nfirst",
      "  评论（2行）:\nfirst",
      "  评论（1行）:",
      "  评论: legacy field in a versioned block",
      "  评论（1行）:\nfirst\nreason: undeclared continuation",
      "  评论（1行）:\nfirst\n  评论（1行）:\nsecond",
      "[2] 文件 · next.ts\n  评论（1行）:\nsecond",
    ];
    for (const body of bodies) {
      const wire = finish(body);
      expect(extractAnnotations(wire)).toEqual({ block: null, text: wire });
    }
    const unsupported = finish("  评论（1行）:\nfirst").replace("annotations/2", "annotations/3");
    expect(extractAnnotations(unsupported)).toEqual({ block: null, text: unsupported });
  });

  test("empty framed comments and ordinary locator keys do not steal the next entry", () => {
    const wire = encodeAnchorsForWire("", [
      { ...sampleAnchors[0], comment: "", locator: { 评论位置: "inline", 文件: "engine.ts" } },
      { ...sampleAnchors[1], comment: "first\nlast" },
    ]);
    const r = extractAnnotations(wire);
    expect(r.block!.entries).toHaveLength(2);
    expect(r.block!.entries[0].comment).toBe("");
    expect(r.block!.entries[0].locator).toEqual([
      { key: "评论位置", value: "inline" },
      { key: "文件", value: "engine.ts" },
    ]);
    expect(r.block!.entries[1].comment).toBe("first\nlast");
  });

  test("existing multiline browser locator values do not prevent comment projection", () => {
    // Browser picker innerText may contain newlines. Its legacy locator display
    // policy is unchanged; only explicitly framed comment lines gain lossless
    // projection in this format.
    const r = extractAnnotations(
      encodeAnchorsForWire("prose", [
        {
          ...sampleAnchors[1],
          locator: { 文本: "visible first line\nvisible second line" },
          comment: "comment first\nreason: comment second",
        },
      ]),
    );
    expect(r.block!.entries).toHaveLength(1);
    expect(r.block!.entries[0].locator).toEqual([{ key: "文本", value: "visible first line" }]);
    expect(r.block!.entries[0].comment).toBe("comment first\nreason: comment second");
    expect(r.text).toBe("prose");
  });
});
