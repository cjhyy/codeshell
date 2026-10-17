import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ToolCall, ToolResult } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/types.ts";

// Exact runtime dependency is replaced before importing the production leaf.
// Only an in-memory warn spy is available; the real file logger is not imported.
const warnings: Array<{ event: string; data: { error?: string } }> = [];
mock.module(
  "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/logging/logger.ts",
  () => ({ logger: { warn: (event: string, data: { error?: string }) => warnings.push({ event, data }) } }),
);
const { generateToolUseSummary } = await import(
  "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/engine/tool-summary.ts"
);

const call = (id = "owned-read", toolName = "Read", args: Record<string, unknown> = { file_path: "owned.ts" }): ToolCall => ({ id, toolName, args });
const result = (id = "owned-read", text = "const owned = 1;"): ToolResult => ({ id, toolName: "Read", result: text, isError: false });

beforeEach(() => { warnings.length = 0; });

describe("round20 actual tool-summary leaf, owned callbacks only", () => {
  test("empty tool batch does not invoke callback", async () => {
    let invoked = 0;
    expect(await generateToolUseSummary([], [], async () => { invoked++; return "unused"; })).toBeNull();
    expect(invoked).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("ordinary aligned batch includes both tool names, JSON args and outputs", async () => {
    const calls = [call(), call("owned-grep", "Grep", { pattern: "owned", count: 2, exact: false })];
    const results = [result(), { id: "owned-grep", toolName: "Grep", result: "2 matches", isError: false }];
    let seen = "";
    let system = "";
    const summary = await generateToolUseSummary(calls, results, async (s, u) => { system = s; seen = u; return "Read and searched"; });
    expect(summary).toBe("Read and searched");
    expect(seen).toBe('Tool: Read({"file_path":"owned.ts"}) → const owned = 1;\nTool: Grep({"pattern":"owned","count":2,"exact":false}) → 2 matches');
    expect(system).toContain("under 40 chars");
    expect(system).toContain("ONLY the summary text");
    expect(warnings).toEqual([]);
  });

  test("ordinary empty success result stays empty in the prompt", async () => {
    let seen = "";
    expect(await generateToolUseSummary([call()], [result("owned-read", "")], async (_s, u) => { seen = u; return "Read empty file"; })).toBe("Read empty file");
    expect(seen).toBe('Tool: Read({"file_path":"owned.ts"}) → ');
    expect(warnings).toEqual([]);
  });

  test("ordinary error-only ToolResult contributes its error message", async () => {
    const error: ToolResult = { id: "owned-read", toolName: "Read", error: "Owned fixture file not found", isError: true };
    let seen = "";
    expect(await generateToolUseSummary([call()], [error], async (_s, u) => { seen = u; return "Read failed"; })).toBe("Read failed");
    expect(seen.endsWith(" → Owned fixture file not found")).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("ASCII args and output are sliced at the production 200/300 limits", async () => {
    const c = call("bounded", "Read", { content: "a".repeat(230) });
    const r = result("bounded", "b".repeat(330));
    let seen = "";
    expect(await generateToolUseSummary([c], [r], async (_s, u) => { seen = u; return "Read bounded text"; })).toBe("Read bounded text");
    expect(seen).toBe(`Tool: Read(${JSON.stringify(c.args).slice(0, 200)}) → ${"b".repeat(300)}`);
    expect(seen.includes("b".repeat(301))).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("the caller-owned signal reaches the callback unchanged", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    expect(await generateToolUseSummary([call()], [result()], async (_s, _u, signal) => { seen = signal; return "Read owned file"; }, controller.signal)).toBe("Read owned file");
    expect(seen).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("already aborted signal is forwarded and Error rejection resolves null", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Owned cancellation"));
    let seen: AbortSignal | undefined;
    expect(await generateToolUseSummary([call()], [result()], async (_s, _u, signal) => { seen = signal; throw signal!.reason; }, controller.signal)).toBeNull();
    expect(seen).toBe(controller.signal);
    expect(warnings).toEqual([{ event: "tool_summary.failed", data: { error: "Owned cancellation" } }]);
  });

  test("summary surrounding whitespace is trimmed", async () => {
    expect(await generateToolUseSummary([call()], [result()], async () => "  Read owned file\n ")).toBe("Read owned file");
    expect(warnings).toEqual([]);
  });

  test("whitespace-only summary resolves null", async () => {
    expect(await generateToolUseSummary([call()], [result()], async () => " \n\t ")).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("ordinary Error rejection resolves null with one warn call", async () => {
    expect(await generateToolUseSummary([call()], [result()], async () => { throw new Error("Owned callback failed"); })).toBeNull();
    expect(warnings).toEqual([{ event: "tool_summary.failed", data: { error: "Owned callback failed" } }]);
  });

  test("related mechanism: handcrafted null rejection escapes as TypeError", async () => {
    // This intentionally characterizes current behavior. No ordinary provider
    // producing this rejection was established, and TurnLoop is not imported.
    await expect(generateToolUseSummary([call()], [result()], async () => { throw null; })).rejects.toBeInstanceOf(TypeError);
    expect(warnings).toEqual([]);
  });

  test("related mechanism: handcrafted undefined rejection also escapes", async () => {
    await expect(generateToolUseSummary([call()], [result()], async () => { throw undefined; })).rejects.toBeInstanceOf(TypeError);
    expect(warnings).toEqual([]);
  });

  test("related control: handcrafted string rejection resolves null", async () => {
    expect(await generateToolUseSummary([call()], [result()], async () => { throw "Owned string rejection"; })).toBeNull();
    expect(warnings).toEqual([{ event: "tool_summary.failed", data: { error: undefined } }]);
  });

  test("ordinary owned inputs are not mutated by summary generation", async () => {
    const calls = [call()];
    const results = [result()];
    const before = JSON.stringify({ calls, results });
    const originalCall = calls[0];
    const originalResult = results[0];
    expect(await generateToolUseSummary(calls, results, async () => "Read owned file")).toBe("Read owned file");
    expect(JSON.stringify({ calls, results })).toBe(before);
    expect(calls[0]).toBe(originalCall);
    expect(results[0]).toBe(originalResult);
    expect(warnings).toEqual([]);
  });
});
