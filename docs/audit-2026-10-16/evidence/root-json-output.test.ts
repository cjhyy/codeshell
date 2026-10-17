import { test, expect } from "bun:test";
import { JsonRenderer, TextRenderer } from "../../../packages/tui/src/cli/output/renderer.ts";

test("A12 JSON final fallback includes child-agent text while text renderer excludes it", () => {
  const original = process.stdout.write;
  const chunks: string[] = [];
  const event = { type: "text_delta", text: "child-only-output", agentId: "child-A" } as any;
  try {
    process.stdout.write = ((value: unknown) => { chunks.push(String(value)); return true; }) as any;
    const text = new TextRenderer();
    text.onEvent(event);
    expect(chunks).toHaveLength(0);
    const json = new JsonRenderer();
    json.onEvent(event);
    json.onComplete("", "aborted_streaming", { sessionId: "parent" });
    const output = JSON.parse(chunks.join(""));
    expect(output.result).toBe("child-only-output");
    expect(output.reason).toBe("aborted_streaming");
  } finally { process.stdout.write = original; }
});
