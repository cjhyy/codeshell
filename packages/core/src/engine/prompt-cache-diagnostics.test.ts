import { describe, expect, it } from "bun:test";
import type { Message, ToolDefinition } from "../types.js";
import {
  PromptCacheDiagnosticRecorder,
  PROMPT_CACHE_STICKINESS_AUDIT,
  createPromptPrefixFingerprint,
  diffPromptMessageChain,
  diffPromptPrefix,
  hashPromptMessages,
  promptCacheDropHint,
  promptCacheDropLogFields,
  hashSystemPrompt,
  hashToolDefinitions,
  type PromptCacheDiagnosticSample,
  type PromptPrefixFingerprint,
} from "./prompt-cache-diagnostics.js";

const KEY = Buffer.alloc(32, 7);

function tool(name: string, inputSchema: Record<string, unknown> = {}): ToolDefinition {
  return { name, description: `${name} description`, inputSchema };
}

function fingerprint(overrides: Partial<PromptPrefixFingerprint> = {}): PromptPrefixFingerprint {
  return {
    version: 1,
    cacheScopeHash: "scope",
    systemHash: "system",
    toolsHash: "tools",
    configHash: "config",
    ...overrides,
  };
}

function cacheSample(cacheReadTokens: number, promptTokens = 300_000): PromptCacheDiagnosticSample {
  return {
    usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1, cacheReadTokens },
    fingerprint: fingerprint(),
    requestKind: "primary",
  };
}

function user(text: string): Message {
  return { role: "user", content: text };
}

function assistant(text: string): Message {
  return { role: "assistant", content: text };
}

function toolResult(id: string, text: string): Message {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] };
}

function chain(messages: Message[]) {
  return hashPromptMessages(messages, KEY);
}

const HISTORY: Message[] = [
  user("first question"),
  assistant("calling a tool"),
  toolResult("call-1", "tool output one"),
  assistant("answer one"),
  user("second question"),
];

describe("prompt cache diagnostics", () => {
  it("hashes identical system prompts identically and detects one-character changes", () => {
    expect(hashSystemPrompt("system", KEY)).toBe(hashSystemPrompt("system", KEY));
    expect(hashSystemPrompt("system", KEY)).not.toBe(hashSystemPrompt("systeM", KEY));
  });

  it("canonicalizes tool object keys while preserving tool array order", () => {
    const left = [tool("A", { type: "object", properties: { b: { type: "string" }, a: 1 } })];
    const equivalent = [tool("A", { properties: { a: 1, b: { type: "string" } }, type: "object" })];
    expect(hashToolDefinitions(left, KEY)).toBe(hashToolDefinitions(equivalent, KEY));
    expect(hashToolDefinitions([tool("A"), tool("B")], KEY)).not.toBe(
      hashToolDefinitions([tool("B"), tool("A")], KEY),
    );
  });

  it("omits credentials from config identity and changes scope for model or endpoint", () => {
    const common = {
      provider: "openai",
      providerKind: "openai",
      model: "gpt-test",
      endpoint: "https://example.com/v1",
    };
    const first = createPromptPrefixFingerprint(
      "sys",
      [],
      { ...common, apiKey: "SECRET_A", httpHeaders: { Authorization: "Bearer A" } },
      common,
      KEY,
    );
    const second = createPromptPrefixFingerprint(
      "sys",
      [],
      { ...common, apiKey: "SECRET_B", httpHeaders: { Authorization: "Bearer B" } },
      common,
      KEY,
    );
    expect(first.configHash).toBe(second.configHash);

    const otherModel = createPromptPrefixFingerprint(
      "sys",
      [],
      common,
      { ...common, model: "gpt-other" },
      KEY,
    );
    const otherEndpoint = createPromptPrefixFingerprint(
      "sys",
      [],
      common,
      { ...common, endpoint: "https://other.example/v1" },
      KEY,
    );
    expect(otherModel.cacheScopeHash).not.toBe(first.cacheScopeHash);
    expect(otherEndpoint.cacheScopeHash).not.toBe(first.cacheScopeHash);
    expect(JSON.stringify(first)).not.toContain("SECRET");
    expect(JSON.stringify(first)).not.toContain("example.com");
  });

  it("attributes system, tools, config, multiple, and untracked changes", () => {
    const base = fingerprint();
    expect(diffPromptPrefix(base, fingerprint({ systemHash: "system-2" }))).toEqual({
      changedPrefixes: ["system"],
      cause: "system_changed",
    });
    expect(diffPromptPrefix(base, fingerprint({ toolsHash: "tools-2" })).cause).toBe(
      "tools_changed",
    );
    expect(diffPromptPrefix(base, fingerprint({ configHash: "config-2" })).cause).toBe(
      "config_changed",
    );
    expect(
      diffPromptPrefix(base, fingerprint({ systemHash: "system-2", toolsHash: "tools-2" })),
    ).toEqual({
      changedPrefixes: ["system", "tools"],
      cause: "multiple_prefixes_changed",
    });
    expect(diffPromptPrefix(base, fingerprint()).cause).toBe("no_tracked_prefix_change");
  });

  it("ignores missing cache reads without replacing the baseline", () => {
    const recorder = new PromptCacheDiagnosticRecorder({ maxSessions: 256 });
    recorder.record("sid", {
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 1200 },
      fingerprint: fingerprint(),
      requestKind: "primary",
    });
    expect(
      recorder.record("sid", {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        fingerprint: fingerprint({ systemHash: "changed" }),
        requestKind: "primary",
      }).kind,
    ).toBe("ignored");
    expect(recorder.get("sid")?.cacheReadTokens).toBe(1200);
  });

  it("attributes a same-scope drop and resets silently on scope or version changes", () => {
    const recorder = new PromptCacheDiagnosticRecorder();
    recorder.record("sid", {
      usage: { promptTokens: 1200, completionTokens: 1, totalTokens: 1201, cacheReadTokens: 1200 },
      fingerprint: fingerprint(),
      requestKind: "primary",
    });
    const drop = recorder.record("sid", {
      usage: { promptTokens: 1200, completionTokens: 1, totalTokens: 1201, cacheReadTokens: 0 },
      fingerprint: fingerprint({ toolsHash: "tools-2" }),
      requestKind: "primary",
    });
    expect(drop).toMatchObject({
      kind: "drop",
      attribution: { cause: "tools_changed", changedPrefixes: ["tools"] },
    });

    expect(
      recorder.record("sid", {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
        fingerprint: fingerprint({ cacheScopeHash: "new-scope" }),
        requestKind: "primary",
      }).kind,
    ).toBe("scope_changed");
    expect(
      recorder.record("sid", {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
        fingerprint: { ...fingerprint({ cacheScopeHash: "new-scope" }), version: 2 as 1 },
        requestKind: "primary",
      }).kind,
    ).toBe("schema_changed");
  });

  it("detects a large partial loss even when tens of thousands of tokens stay cached", () => {
    const recorder = new PromptCacheDiagnosticRecorder();
    recorder.record("sid", cacheSample(256_193), 1000);

    const drop = recorder.record("sid", cacheSample(27_131), 2000);
    expect(drop).toMatchObject({
      kind: "drop",
      previous: { cacheReadTokens: 256_193, sampledAtMs: 1000 },
      current: { cacheReadTokens: 27_131, sampledAtMs: 2000 },
      attribution: { cause: "no_tracked_prefix_change", changedPrefixes: [] },
    });
    if (drop.kind === "drop") {
      expect(drop.dropRatio).toBeCloseTo(27_131 / 256_193);
    }
    expect(recorder.record("sid", cacheSample(27_131), 3000).kind).toBe("updated");
  });

  it("requires both a large relative and absolute loss for partial cache drops", () => {
    const cases = [
      { previous: 8192, current: 4096, expected: "drop" },
      { previous: 8192, current: 4097, expected: "updated" },
      { previous: 8190, current: 4095, expected: "updated" },
      { previous: 256_000, current: 240_000, expected: "updated" },
      { previous: 1200, current: 120, expected: "updated" },
      { previous: 1200, current: 64, expected: "drop" },
    ];
    for (const { previous, current, expected } of cases) {
      const recorder = new PromptCacheDiagnosticRecorder();
      recorder.record("sid", cacheSample(previous));
      expect(recorder.record("sid", cacheSample(current)).kind).toBe(expected);
    }
  });

  it("does not report cold starts, warm-up, or lower hit rates from appended input", () => {
    const recorder = new PromptCacheDiagnosticRecorder();
    expect(recorder.record("sid", cacheSample(0, 10_000)).kind).toBe("baseline");
    expect(recorder.record("sid", cacheSample(0, 10_000)).kind).toBe("updated");
    expect(recorder.record("sid", cacheSample(8192, 10_000)).kind).toBe("updated");
    expect(recorder.record("sid", cacheSample(8192, 100_000)).kind).toBe("updated");
    expect(recorder.record("sid", cacheSample(16_384, 200_000)).kind).toBe("updated");
  });

  it("resets partial-drop comparisons on scope and fingerprint schema changes", () => {
    const recorder = new PromptCacheDiagnosticRecorder();
    recorder.record("scope", cacheSample(256_193));
    expect(
      recorder.record("scope", {
        ...cacheSample(27_131),
        fingerprint: fingerprint({ cacheScopeHash: "new-model" }),
      }).kind,
    ).toBe("scope_changed");
    recorder.record("schema", cacheSample(256_193));
    expect(
      recorder.record("schema", {
        ...cacheSample(27_131),
        fingerprint: { ...fingerprint(), version: 2 as 1 },
      }).kind,
    ).toBe("schema_changed");
  });

  it("evicts the least-recently-used session beyond the bound", () => {
    const recorder = new PromptCacheDiagnosticRecorder({ maxSessions: 256 });
    for (let index = 0; index < 260; index++) {
      recorder.record(`s-${index}`, {
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheReadTokens: index },
        fingerprint: fingerprint(),
        requestKind: "primary",
      });
    }
    expect(recorder.size).toBe(256);
    expect(recorder.has("s-0")).toBe(false);
    expect(recorder.has("s-259")).toBe(true);
  });

  it("audits semantic and security switches as hot while reserving locks for cache-only policy", () => {
    for (const key of [
      "planMode",
      "permissionMode",
      "goalState",
      "mcpServerSet",
      "toolAvailability",
    ]) {
      expect(PROMPT_CACHE_STICKINESS_AUDIT[key]?.policy).toBe("hot");
    }
    expect(PROMPT_CACHE_STICKINESS_AUDIT.providerCacheStrategy.policy).toBe("client_sticky");
    expect(PROMPT_CACHE_STICKINESS_AUDIT.futureCacheOnlyPolicy.policy).toBe(
      "session_lock_if_introduced",
    );
  });

  describe("message chain", () => {
    it("stores one keyed hash, role, and tool-result flag per message and never the text", () => {
      const digests = chain(HISTORY);
      expect(digests).toHaveLength(HISTORY.length);
      expect(digests.map((digest) => digest.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(digests.map((digest) => digest.hasToolResult)).toEqual([
        false,
        false,
        true,
        false,
        false,
      ]);
      expect(chain([{ role: "tool", content: "out", tool_call_id: "c" }])[0].hasToolResult).toBe(
        true,
      );
      for (const digest of digests) expect(digest.hash).toMatch(/^[0-9a-f]{16}$/);
      const serialized = JSON.stringify(digests);
      expect(serialized).not.toContain("question");
      expect(serialized).not.toContain("tool output");
      expect(chain(HISTORY)).toEqual(digests);
      expect(hashPromptMessages(HISTORY, Buffer.alloc(32, 8))[0].hash).not.toBe(digests[0].hash);
    });

    it("hashes by content: key order is irrelevant, any nested byte change is not", () => {
      const left: Message = {
        role: "assistant",
        content: [{ type: "tool_use", id: "c", name: "Read", input: { a: 1, token: "x" } }],
      };
      const reordered: Message = {
        content: [{ input: { token: "x", a: 1 }, name: "Read", id: "c", type: "tool_use" }],
        role: "assistant",
      };
      const changed: Message = {
        role: "assistant",
        content: [{ type: "tool_use", id: "c", name: "Read", input: { a: 1, token: "y" } }],
      };
      expect(chain([left])[0].hash).toBe(chain([reordered])[0].hash);
      expect(chain([left])[0].hash).not.toBe(chain([changed])[0].hash);
      expect(chain([user("a")])[0].hash).not.toBe(chain([assistant("a")])[0].hash);
    });

    it("classifies append-only growth and identical lists without a changed index", () => {
      const previous = chain(HISTORY);
      expect(diffPromptMessageChain(previous, chain([...HISTORY, assistant("more")]))).toEqual({
        messageChange: "append_only",
        previousMessageCount: 5,
        currentMessageCount: 6,
      });
      expect(diffPromptMessageChain(previous, chain(HISTORY))).toEqual({
        messageChange: "append_only",
        previousMessageCount: 5,
        currentMessageCount: 5,
      });
      expect(diffPromptMessageChain([], chain(HISTORY)).messageChange).toBe("append_only");
    });

    it("classifies a message rewritten in place", () => {
      const current = [...HISTORY, assistant("answer two")];
      current[2] = toolResult("call-1", "[cleared]");
      expect(diffPromptMessageChain(chain(HISTORY), chain(current))).toEqual({
        messageChange: "rewritten",
        firstChangedMessageIndex: 2,
        previousMessageCount: 5,
        currentMessageCount: 6,
        changedMessageRole: "user",
        changedMessageHasToolResult: true,
      });
      // The last message replaced: same position, nothing after it to disagree.
      expect(
        diffPromptMessageChain(chain(HISTORY), chain([...HISTORY.slice(0, 4), user("edited")])),
      ).toMatchObject({ messageChange: "rewritten", firstChangedMessageIndex: 4 });
    });

    it("classifies a message removed from the middle", () => {
      const current = [...HISTORY.slice(0, 1), ...HISTORY.slice(2), assistant("answer two")];
      expect(diffPromptMessageChain(chain(HISTORY), chain(current))).toEqual({
        messageChange: "removed",
        firstChangedMessageIndex: 1,
        previousMessageCount: 5,
        currentMessageCount: 5,
        // current[1] is the tool result that moved up into the removed slot.
        changedMessageRole: "user",
        changedMessageHasToolResult: true,
      });
    });

    it("classifies a truncated tail as removed and reports the previous message", () => {
      expect(diffPromptMessageChain(chain(HISTORY), chain(HISTORY.slice(0, 3)))).toEqual({
        messageChange: "removed",
        firstChangedMessageIndex: 3,
        previousMessageCount: 5,
        currentMessageCount: 3,
        changedMessageRole: "assistant",
        changedMessageHasToolResult: false,
      });
    });

    it("classifies a message inserted in the middle", () => {
      const current = [
        ...HISTORY.slice(0, 2),
        assistant("injected note"),
        ...HISTORY.slice(2),
        assistant("answer two"),
      ];
      expect(diffPromptMessageChain(chain(HISTORY), chain(current))).toEqual({
        messageChange: "inserted",
        firstChangedMessageIndex: 2,
        previousMessageCount: 5,
        currentMessageCount: 7,
        changedMessageRole: "assistant",
        changedMessageHasToolResult: false,
      });
    });

    it("classifies everything else as diverged", () => {
      const current = [HISTORY[0], user("summary of everything so far"), user("third question")];
      expect(diffPromptMessageChain(chain(HISTORY), chain(current))).toEqual({
        messageChange: "diverged",
        firstChangedMessageIndex: 1,
        previousMessageCount: 5,
        currentMessageCount: 3,
        changedMessageRole: "user",
        changedMessageHasToolResult: false,
      });
      // Two messages removed is not a single-message shift.
      expect(
        diffPromptMessageChain(chain(HISTORY), chain([HISTORY[0], ...HISTORY.slice(3)]))
          .messageChange,
      ).toBe("diverged");
    });
  });

  describe("message attribution of cache-read drops", () => {
    function messageSample(cacheReadTokens: number, messages: Message[], head = {}) {
      return {
        ...cacheSample(cacheReadTokens),
        fingerprint: fingerprint(head),
        messages: chain(messages),
      };
    }

    it("keeps the first sample as a baseline with its message chain", () => {
      const recorder = new PromptCacheDiagnosticRecorder();
      expect(recorder.record("sid", messageSample(256_000, HISTORY)).kind).toBe("baseline");
      expect(recorder.get("sid")?.messages).toEqual(chain(HISTORY));
    });

    it("reports message_prefix_changed when only the message list changed", () => {
      const recorder = new PromptCacheDiagnosticRecorder();
      recorder.record("sid", messageSample(256_000, HISTORY));
      const current = [...HISTORY.slice(0, 1), ...HISTORY.slice(2), assistant("answer two")];
      const drop = recorder.record("sid", messageSample(20_000, current));
      expect(drop).toMatchObject({
        kind: "drop",
        attribution: {
          cause: "message_prefix_changed",
          changedPrefixes: [],
          messages: { messageChange: "removed", firstChangedMessageIndex: 1 },
        },
      });
      if (drop.kind !== "drop") throw new Error("expected drop");
      expect(promptCacheDropLogFields(drop.attribution)).toEqual({
        cause: "message_prefix_changed",
        changedPrefixes: [],
        messageChange: "removed",
        firstChangedMessageIndex: 1,
        previousMessageCount: 5,
        currentMessageCount: 5,
        changedMessageRole: "user",
        changedMessageHasToolResult: true,
        hint: promptCacheDropHint(drop.attribution),
      });
      const hint = promptCacheDropHint(drop.attribution);
      expect(hint).toContain("removed");
      expect(hint).toContain("index 1");
    });

    it("names the kind and index for rewritten, inserted, and diverged lists", () => {
      const rewritten = [...HISTORY];
      rewritten[2] = toolResult("call-1", "[cleared]");
      const inserted = [...HISTORY.slice(0, 2), assistant("note"), ...HISTORY.slice(2)];
      const diverged = [HISTORY[0], user("summary"), user("next")];
      for (const [current, messageChange, index] of [
        [rewritten, "rewritten", 2],
        [inserted, "inserted", 2],
        [diverged, "diverged", 1],
      ] as const) {
        const recorder = new PromptCacheDiagnosticRecorder();
        recorder.record("sid", messageSample(256_000, HISTORY));
        const drop = recorder.record("sid", messageSample(0, current));
        if (drop.kind !== "drop") throw new Error("expected drop");
        expect(drop.attribution.cause).toBe("message_prefix_changed");
        const fields = promptCacheDropLogFields(drop.attribution);
        expect(fields).toMatchObject({ messageChange, firstChangedMessageIndex: index });
        expect(fields.hint).toContain(messageChange);
        expect(fields.hint).toContain(`index ${index}`);
      }
    });

    it("keeps no_tracked_prefix_change for append-only message lists", () => {
      const recorder = new PromptCacheDiagnosticRecorder();
      recorder.record("sid", messageSample(256_000, HISTORY));
      const drop = recorder.record("sid", messageSample(0, [...HISTORY, assistant("more")]));
      if (drop.kind !== "drop") throw new Error("expected drop");
      expect(drop.attribution.cause).toBe("no_tracked_prefix_change");
      const fields = promptCacheDropLogFields(drop.attribution);
      expect(fields).toMatchObject({
        cause: "no_tracked_prefix_change",
        messageChange: "append_only",
        previousMessageCount: 5,
        currentMessageCount: 6,
      });
      expect("firstChangedMessageIndex" in fields).toBe(false);
    });

    it("keeps head causes and hints but still reports the message change", () => {
      const recorder = new PromptCacheDiagnosticRecorder();
      recorder.record("sid", messageSample(256_000, HISTORY));
      const rewritten = [...HISTORY];
      rewritten[0] = user("edited");
      const drop = recorder.record("sid", messageSample(0, rewritten, { toolsHash: "tools-2" }));
      if (drop.kind !== "drop") throw new Error("expected drop");
      expect(drop.attribution.cause).toBe("tools_changed");
      expect(promptCacheDropLogFields(drop.attribution)).toMatchObject({
        cause: "tools_changed",
        changedPrefixes: ["tools"],
        messageChange: "rewritten",
        firstChangedMessageIndex: 0,
        hint: promptCacheDropHint({ cause: "tools_changed", changedPrefixes: ["tools"] }),
      });
    });

    it("omits message fields when either sample carries no message chain", () => {
      const recorder = new PromptCacheDiagnosticRecorder();
      recorder.record("sid", cacheSample(256_000));
      const drop = recorder.record("sid", messageSample(0, HISTORY));
      if (drop.kind !== "drop") throw new Error("expected drop");
      expect(drop.attribution).toEqual({ cause: "no_tracked_prefix_change", changedPrefixes: [] });
      expect(promptCacheDropLogFields(drop.attribution)).toEqual({
        cause: "no_tracked_prefix_change",
        changedPrefixes: [],
        hint: promptCacheDropHint(drop.attribution),
      });
    });
  });
});
