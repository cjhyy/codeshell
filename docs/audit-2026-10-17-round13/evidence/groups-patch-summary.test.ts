import { describe, expect, test } from "bun:test";
import { aggregateFileChangeSummary } from "../../../../packages/desktop/src/renderer/messages/fileChangeAggregator";
import { parsePatch } from "../../../../packages/coding/src/tools/apply-patch/parser";
import type { AgentMessage, Message, ToolMessage } from "../../../../packages/desktop/src/renderer/types";

const user: Message = { kind: "user", id: "user-1", text: "Update the example counters" };
function tool(id: string, patch: string, status: ToolMessage["status"] = "succeeded"): ToolMessage {
  return { kind: "tool", id, toolName: "ApplyPatch", args: JSON.stringify({ patch }), status, startedAt: 1000, endedAt: 1010 };
}
function patch(...body: string[]): string {
  return ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
}
const ordinaryUpdate = patch("*** Update File: counter.ts", "@@", "-counter -= 1;", "+counter += 1;");

describe("round13: actual pure V4A parser versus Desktop file summary", () => {
  test("a valid header-only Delete has a real delete AST but disappears from the summary", () => {
    const text = patch("*** Delete File: obsolete.ts");
    expect(parsePatch(text).hunks).toEqual([{ kind: "delete", path: "obsolete.ts" }]);
    const message = tool("delete", text);
    expect(message.status).toBe("succeeded");
    expect(aggregateFileChangeSummary([user, message])).toBeNull();
    console.log("DELETE_OBSERVED", JSON.stringify({ ast: parsePatch(text).hunks, summary: aggregateFileChangeSummary([user, message]) }));
  });

  test("a valid Delete remains absent even beside a supported successful update", () => {
    const text = patch("*** Update File: counter.ts", "@@", "-counter -= 1;", "+counter += 1;", "*** Delete File: obsolete.ts");
    expect(parsePatch(text).hunks.map((hunk) => hunk.kind)).toEqual(["update", "delete"]);
    const summary = aggregateFileChangeSummary([user, tool("mixed", text)]);
    expect(summary?.files).toEqual([{ path: "counter.ts", added: 1, removed: 1, count: 1 }]);
    expect(summary?.sessionDiffs.map((diff) => diff.path)).toEqual(["counter.ts"]);
  });

  test("increment and decrement source lines are valid V4A content but both get filtered as headers", () => {
    const text = patch("*** Update File: counter.ts", "@@", "---counter;", "+++counter;");
    expect(parsePatch(text).hunks).toEqual([{ kind: "update", path: "counter.ts", movePath: undefined, chunks: [{ oldLines: ["--counter;"], newLines: ["++counter;"], isEndOfFile: false }] }]);
    expect(aggregateFileChangeSummary([user, tool("prefix", text)])).toBeNull();
    console.log("PREFIX_OBSERVED", JSON.stringify({ ast: parsePatch(text).hunks, summary: aggregateFileChangeSummary([user, tool("prefix", text)]) }));
  });

  test("one ignored increment line produces an incorrect surviving removal-only diff", () => {
    const text = patch("*** Update File: counter.ts", "@@", "-counter += 1;", "+++counter;");
    expect(parsePatch(text).hunks[0]).toMatchObject({ kind: "update", chunks: [{ oldLines: ["counter += 1;"], newLines: ["++counter;"] }] });
    const summary = aggregateFileChangeSummary([user, tool("partial", text)]);
    expect(summary?.files).toEqual([{ path: "counter.ts", added: 0, removed: 1, count: 1 }]);
    expect(summary?.sessionDiffs[0]?.diff).toContain("-counter += 1;");
    expect(summary?.sessionDiffs[0]?.diff).not.toContain("+++counter;");
  });

  test("ordinary update/add payloads and failed operations are controls", () => {
    expect(aggregateFileChangeSummary([user, tool("normal", ordinaryUpdate)])?.files).toEqual([{ path: "counter.ts", added: 1, removed: 1, count: 1 }]);
    const add = patch("*** Add File: fresh.ts", "+const counter = 0;");
    expect(parsePatch(add).hunks).toEqual([{ kind: "add", path: "fresh.ts", contents: "const counter = 0;\n" }]);
    expect(aggregateFileChangeSummary([user, tool("add", add)])?.files).toEqual([{ path: "fresh.ts", added: 1, removed: 0, count: 1 }]);
    expect(aggregateFileChangeSummary([user, tool("failed", ordinaryUpdate, "failed")])).toBeNull();
  });

  test("the same deletion gap applies to nested subagent tool messages", () => {
    const text = patch("*** Delete File: child-obsolete.ts");
    const child: AgentMessage = { kind: "agent", id: "agent-1", description: "Remove obsolete counter", done: true, startedAt: 1000, endedAt: 1010, toolCount: 1, toolCalls: [tool("nested-delete", text)], textBuffer: "" };
    expect(parsePatch(text).hunks[0]).toEqual({ kind: "delete", path: "child-obsolete.ts" });
    expect(aggregateFileChangeSummary([user, child])).toBeNull();
  });

  test("a valid rename is another unsupported parser branch, related to the old external rename family", () => {
    const text = patch("*** Update File: old.ts", "*** Move to: new.ts", "@@", "-const counter = 0;", "+const counter = 1;");
    expect(parsePatch(text).hunks[0]).toMatchObject({ kind: "update", path: "old.ts", movePath: "new.ts", chunks: [{ oldLines: ["const counter = 0;"], newLines: ["const counter = 1;"] }] });
    expect(aggregateFileChangeSummary([user, tool("rename", text)])).toBeNull();
    console.log("RENAME_OBSERVED", JSON.stringify({ ast: parsePatch(text).hunks, summary: aggregateFileChangeSummary([user, tool("rename", text)]) }));
  });
});
