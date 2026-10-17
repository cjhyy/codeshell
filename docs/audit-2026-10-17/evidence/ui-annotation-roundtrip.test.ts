import { test, expect } from "bun:test";
import {
  encodeAnchorsForWire,
  extractAnnotations,
  type Anchor,
} from "../../../packages/desktop/src/renderer/chat/anchors";

const anchor: Anchor = {
  id: "audit-comment",
  kind: "file",
  label: "example.ts:10",
  locator: { 文件: "example.ts", 行: "10" },
  comment: "第一行说明\n第二行必须保留\nreason: 该字段是评论内容",
};

test("round 2: observes multiline comment display truncation in production codec", () => {
  const wire = encodeAnchorsForWire("按评论修改", [anchor]);
  const projected = extractAnnotations(wire);
  expect(wire).toContain(anchor.comment);
  expect(projected.text).toBe("按评论修改");
  expect(projected.block?.entries).toHaveLength(1);
  expect(projected.block!.entries[0]!.comment).toBe("第一行说明");
  expect(projected.block!.entries[0]!.locator).toContainEqual({ key: "reason", value: "该字段是评论内容" });
  expect(projected.block!.entries[0]!.comment).not.toBe(anchor.comment);
  console.log(JSON.stringify({ observation: "multiline-comment-projection", inputComment: anchor.comment, displayedComment: projected.block!.entries[0]!.comment, displayedLocators: projected.block!.entries[0]!.locator, originalWireRetainsFullComment: wire.includes(anchor.comment) }));
});

test("round 2 control: one-line comment retains exact text", () => {
  const single = { ...anchor, comment: "单行完整评论" };
  const projected = extractAnnotations(encodeAnchorsForWire("", [single]));
  expect(projected.block!.entries[0]!.comment).toBe(single.comment);
  expect(projected.block!.entries[0]!.locator).toEqual([{ key: "文件", value: "example.ts" }, { key: "行", value: "10" }]);
});
