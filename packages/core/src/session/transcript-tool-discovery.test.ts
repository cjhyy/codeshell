import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, Message, ToolDefinition } from "../types.js";
import {
  joinToolResultText,
  matchesToolDiscoverySchema,
  toolDiscoverySchemaBlock,
} from "../utils/tool-schema-discovery.js";
import { SessionManager } from "./session-manager.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const tool: ToolDefinition = {
  name: "mcp__catalog__lookup",
  description: "完整持久化 🧪",
  inputSchema: {
    type: "object",
    properties: {
      records: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
    required: ["records"],
  },
};

function resultContent(messages: Message[]): ContentBlock[] {
  const result = messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .find((block) => block.type === "tool_result");
  if (!result || !Array.isArray(result.content))
    throw new Error("Missing structured discovery result");
  return result.content;
}

describe("portable discovery transcript persistence", () => {
  test.each([false, true])(
    "resume, checkpoint and fork retain full schema with malformed metadata=%s",
    (malformed) => {
      const directory = mkdtempSync(join(tmpdir(), "discovery-transcript-"));
      directories.push(directory);
      const manager = new SessionManager(directory);
      const source = manager.create("/project", "model", "anthropic", "source");
      const schemaBlock = toolDiscoverySchemaBlock(tool);
      if (malformed)
        schemaBlock.discoveredTool = { version: 99, name: "invalid", schemaDigest: null } as never;
      const blocks: ContentBlock[] = [
        { type: "text", text: "health\n\n" },
        schemaBlock,
        { type: "text", text: "\n\nUse CallTool." },
      ];
      source.transcript.appendMessage("user", "find this tool");
      source.transcript.appendMessage("assistant", [
        {
          type: "tool_use",
          id: "discover",
          name: "ToolSearch",
          input: { query: `select:${tool.name}` },
        },
      ]);
      source.transcript.appendToolUse("ToolSearch", "discover", { query: `select:${tool.name}` });
      source.transcript.appendToolResult(
        "discover",
        "ToolSearch",
        "legacy display text",
        undefined,
        blocks,
      );
      const covered = source.transcript.appendMessage("assistant", "Tool ready");
      const original = JSON.stringify(blocks);
      const resumed = new SessionManager(directory).resume("source");
      expect(JSON.stringify(resultContent(resumed.transcript.toMessages()))).toBe(original);

      const snapshot: Message[] = [
        { role: "user", content: "checkpoint background replaces the original question" },
        ...source.transcript.toMessages().slice(1),
      ];
      const note = source.transcript.appendContextNote("checkpoint background", covered.id)!;
      const checkpoint = source.transcript.appendContextCheckpoint({
        version: 1,
        noteId: note.id,
        coveredThroughEventId: covered.id,
        messages: snapshot,
        clientMessageIds: [],
      });
      expect(checkpoint).toBeDefined();
      const restored = new SessionManager(directory).resume("source").transcript.toMessages();
      expect(restored).toEqual(snapshot);
      const fork = manager.fork("source", { targetSessionId: "child" });
      expect(fork.bundle.transcript.getEvents("context_checkpoint")[0]!.id).not.toBe(
        checkpoint!.id,
      );
      const child = new SessionManager(directory).resume("child").transcript.toMessages();
      expect(child).toEqual(snapshot);
      for (const messages of [restored, child]) {
        const content = resultContent(messages);
        expect(JSON.stringify(content)).toBe(original);
        expect(joinToolResultText(content, "\n")).toBe(
          `health\n\n${schemaBlock.text}\n\nUse CallTool.`,
        );
        expect(matchesToolDiscoverySchema(content[1]!, tool)).toBe(!malformed);
      }
      resultContent(child)[1]!.text = "modified child";
      expect(JSON.stringify(resultContent(source.transcript.toMessages()))).toBe(original);
    },
  );
});
