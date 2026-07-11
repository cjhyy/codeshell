import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "../types.js";
import {
  applyToolResultPersistence,
  createContentReplacementState,
} from "./tool-result-storage.js";

function toolResultMessage(toolUseId: string, content = "secret output"): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  } as unknown as Message;
}

describe("tool-result persistence safe filenames", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "codeshell-tool-result-security-"));
    roots.push(root);
    return { root, toolResultsDir: join(root, "sessions", "tool-results") };
  }

  it.each(["../../etc/passwd", "/tmp/codeshell-absolute-tool-id", "..\\..\\windows"])(
    "rejects path-like external toolUseId %s without writing a file",
    (toolUseId) => {
      const { root, toolResultsDir } = fixture();
      // Make the traversal destination's parent exist so the vulnerable
      // join(dir, toolUseId) implementation would successfully write outside.
      mkdirSync(join(root, "etc"), { recursive: true });
      const state = createContentReplacementState();
      const input = toolResultMessage(toolUseId);

      const output = applyToolResultPersistence([input], {
        toolResultsDir,
        state,
        perResultThreshold: 0,
      });

      expect(output).toEqual([input]);
      expect(state.replacements.has(toolUseId)).toBe(false);
      expect(existsSync(join(root, "etc", "passwd.txt"))).toBe(false);
      expect(existsSync("/tmp/codeshell-absolute-tool-id.txt")).toBe(false);
      expect(existsSync(toolResultsDir) ? readdirSync(toolResultsDir) : []).toEqual([]);
    },
  );

  it("rejects a toolUseId longer than 256 characters", () => {
    const { toolResultsDir } = fixture();
    const toolUseId = "x".repeat(257);
    const state = createContentReplacementState();
    const input = toolResultMessage(toolUseId);

    const output = applyToolResultPersistence([input], {
      toolResultsDir,
      state,
      perResultThreshold: 0,
    });

    expect(output).toEqual([input]);
    expect(state.replacements.has(toolUseId)).toBe(false);
    expect(existsSync(toolResultsDir) ? readdirSync(toolResultsDir) : []).toEqual([]);
  });

  it("hashes a legal toolUseId while preserving the original-id mapping", () => {
    const { toolResultsDir } = fixture();
    const toolUseId = "call_external-model_123";
    const content = "large result from external model";
    const state = createContentReplacementState();
    const persisted: Array<{ toolUseId: string; filepath: string }> = [];

    const output = applyToolResultPersistence([toolResultMessage(toolUseId, content)], {
      toolResultsDir,
      state,
      perResultThreshold: 0,
      onPersist: ({ toolUseId: originalId, filepath }) =>
        persisted.push({ toolUseId: originalId, filepath }),
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.toolUseId).toBe(toolUseId);
    expect(basename(persisted[0]!.filepath)).toMatch(/^[a-f0-9]{64}\.txt$/);
    expect(basename(persisted[0]!.filepath)).not.toContain(toolUseId);
    expect(readFileSync(persisted[0]!.filepath, "utf8")).toBe(content);
    expect(state.replacements.has(toolUseId)).toBe(true);
    expect(JSON.stringify(output)).toContain(persisted[0]!.filepath);
  });
});
