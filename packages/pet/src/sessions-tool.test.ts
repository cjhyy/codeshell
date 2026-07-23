import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsTool, SESSIONS_TOOL_NAME, sessionsToolDef } from "./sessions-tool.js";
import { sessionSelectorId } from "./disclosure/selector.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pet-sessions-tool-"));
  const dir = join(root, "work-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ summary: "fix payment bug", cwd: "/repo/a" }),
  );
  writeFileSync(
    join(dir, "transcript.jsonl"),
    [
      JSON.stringify({
        id: "e0",
        type: "message",
        timestamp: 1,
        turnNumber: 0,
        data: { role: "user", content: "fix payment bug" },
      }),
      JSON.stringify({
        id: "e1",
        type: "tool_use",
        timestamp: 2,
        turnNumber: 0,
        data: {
          toolName: "TodoWrite",
          args: {
            todos: [{ content: "patch checkout", status: "pending", activeForm: "patching" }],
          },
        },
      }),
      JSON.stringify({
        id: "e2",
        type: "message",
        timestamp: 3,
        turnNumber: 0,
        data: { role: "assistant", content: "Patched the payment flow in checkout.ts." },
      }),
    ].join("\n"),
  );
  return root;
}

const ctxFor = (root: string) => ({ runScopedServices: { petSessionsRootDir: root } }) as never;

describe("sessionsToolDef", () => {
  test("exposes list/describe/search enum and name Sessions", () => {
    expect(sessionsToolDef.name).toBe("Sessions");
    expect(SESSIONS_TOOL_NAME).toBe("Sessions");
    const schema = sessionsToolDef.inputSchema as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual(["list", "describe", "search"]);
  });
});

describe("sessionsTool", () => {
  test("list returns L1 rows with selector and untrusted note", async () => {
    const root = makeRoot();
    const result = await sessionsTool({ action: "list" }, ctxFor(root));
    const parsed = JSON.parse(result) as {
      untrusted: string;
      sessions: Array<{ sessionId: string; selector: string }>;
    };
    expect(parsed.untrusted).toContain("data");
    expect(parsed.sessions.length).toBe(1);
    expect(parsed.sessions[0]!.sessionId).toBe("work-1");
    expect(parsed.sessions[0]!.selector).toBe(sessionSelectorId("work-1"));
  });

  test("describe returns latestResult, todos, and selector", async () => {
    const root = makeRoot();
    const result = await sessionsTool({ action: "describe", session_id: "work-1" }, ctxFor(root));
    const parsed = JSON.parse(result) as {
      selector: string;
      latestResult: { text: string };
      todos: Array<{ subject: string }>;
    };
    expect(parsed.latestResult.text).toContain("Patched the payment flow");
    expect(parsed.todos[0]!.subject).toBe("patch checkout");
    expect(parsed.selector).toBe(sessionSelectorId("work-1"));
  });

  test("search finds sessionId by query", async () => {
    const root = makeRoot();
    const result = await sessionsTool({ action: "search", query: "checkout" }, ctxFor(root));
    const parsed = JSON.parse(result) as { matches: Array<{ sessionId: string }> };
    expect(parsed.matches.some((match) => match.sessionId === "work-1")).toBe(true);
  });

  test("describe without session_id errors", async () => {
    const root = makeRoot();
    const result = await sessionsTool({ action: "describe" }, ctxFor(root));
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("unknown extra arg on list errors", async () => {
    const root = makeRoot();
    const result = await sessionsTool({ action: "list", query: "nope" }, ctxFor(root));
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("describe on nonexistent id errors", async () => {
    const root = makeRoot();
    const result = await sessionsTool(
      { action: "describe", session_id: "does-not-exist" },
      ctxFor(root),
    );
    expect(result.startsWith("Error:")).toBe(true);
  });
});
