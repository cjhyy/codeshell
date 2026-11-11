import { describe, expect, test } from "bun:test";
import { createReplyModels } from "./pet-notice-reply-models.js";
import { interpretReply } from "./pet-notice-reply-interpreter.js";

function settings(extra: Record<string, unknown> = {}) {
  return {
    credentials: [{ id: "fixture-key", catalogId: "openai", apiKey: "unused-fixture-key" }],
    modelConnections: [
      {
        id: "aux",
        catalogId: "openai",
        tag: "text",
        model: "gpt-4o-mini",
        credentialId: "fixture-key",
      },
      {
        id: "main",
        catalogId: "openai",
        tag: "text",
        model: "gpt-4o",
        credentialId: "fixture-key",
      },
    ],
    defaults: { text: "main", auxText: "aux" },
    ...extra,
  } as never;
}

const ITEMS = [
  {
    ordinal: 1,
    ref: "approval-one",
    kind: "approval" as const,
    text: "允许读取？",
    actions: ["approve" as const],
  },
];

describe("provider-aware notice reply model chain", () => {
  test.each(["codex/gpt-6.1-sol", "claude-code/sonnet"])(
    "external default %s interprets with exactly one external candidate",
    async (model) => {
      const native: string[] = [];
      const external: string[] = [];
      const models = createReplyModels("/unused", {
        readSettings: () => settings({ sessionDefaults: { model } }),
        external: async (selected) => {
          external.push(selected);
          return '{"kind":"unrelated"}';
        },
        callNative: async (config) => {
          native.push(config.model);
          return "{}";
        },
      });
      expect(models).toHaveLength(1);
      expect(await interpretReply({ message: "你好", items: ITEMS, models })).toEqual({
        kind: "unrelated",
      });
      expect(external).toEqual([model]);
      expect(native).toEqual([]);
    },
  );

  test("Mimi's explicit provider override wins over the global default", async () => {
    const selected: string[] = [];
    const models = createReplyModels("/unused", {
      readSettings: () =>
        settings({ sessionDefaults: { model: "main" }, pet: { chatModelKey: "claude-code/opus" } }),
      external: async (model) => {
        selected.push(model);
        return '{"kind":"unrelated"}';
      },
      callNative: async () => {
        throw new Error("Native inference must not run");
      },
    });
    await interpretReply({ message: "下一件事", items: ITEMS, models });
    expect(selected).toEqual(["claude-code/opus"]);
  });

  test.each(["unavailable", "throws", "invalid-output"])(
    "external %s never tries the configured native auxiliary or main model",
    async (mode) => {
      let nativeCalls = 0;
      const models = createReplyModels("/unused", {
        readSettings: () => settings({ sessionDefaults: { model: "codex/gpt-6.1-sol" } }),
        ...(mode === "unavailable"
          ? {}
          : {
              external: async () => {
                if (mode === "throws") throw new Error("External quota unavailable");
                return "Not an interpretation";
              },
            }),
        callNative: async () => {
          nativeCalls++;
          return '{"kind":"unrelated"}';
        },
      });
      expect(await interpretReply({ message: "批准", items: ITEMS, models })).toBeUndefined();
      expect(nativeCalls).toBe(0);
    },
  );

  test("native selection keeps auxiliary then the explicitly selected main model", async () => {
    const calls: string[] = [];
    const models = createReplyModels("/unused", {
      readSettings: () => settings({ sessionDefaults: { model: "main" } }),
      callNative: async (config) => {
        calls.push(config.model);
        if (config.model === "gpt-4o-mini") throw new Error("Auxiliary unavailable");
        return '{"kind":"unrelated"}';
      },
      external: async () => {
        throw new Error("External inference must not run");
      },
    });
    expect(await interpretReply({ message: "新话题", items: ITEMS, models })).toEqual({
      kind: "unrelated",
    });
    expect(calls).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  test("a native Mimi override wins over an external global default", async () => {
    const calls: string[] = [];
    const models = createReplyModels("/unused", {
      readSettings: () =>
        settings({
          sessionDefaults: { model: "codex/gpt-6.1-sol" },
          pet: { chatModelKey: "main" },
        }),
      callNative: async (config) => {
        calls.push(config.model);
        return '{"kind":"unrelated"}';
      },
    });
    await interpretReply({ message: "新话题", items: ITEMS, models });
    expect(calls).toEqual(["gpt-4o-mini"]);
  });

  test("native main is not called twice when no separate auxiliary is configured", async () => {
    let calls = 0;
    const models = createReplyModels("/unused", {
      readSettings: () => settings({ defaults: { text: "main" } }),
      callNative: async () => {
        calls++;
        return "invalid";
      },
    });
    expect(await interpretReply({ message: "不明确", items: ITEMS, models })).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("a provider is pinned for this reply while the next chain reads changed settings", async () => {
    let current = settings({ sessionDefaults: { model: "codex/gpt-6.1-sol" } });
    const external: string[] = [];
    const options = {
      readSettings: () => current,
      external: async (model: string) => {
        external.push(model);
        return '{"kind":"unrelated"}';
      },
      callNative: async () => '{"kind":"unrelated"}',
    };
    const models = createReplyModels("/unused", options);
    current = settings({ sessionDefaults: { model: "main" } });
    await interpretReply({ message: "第一条", items: ITEMS, models });
    expect(external).toEqual(["codex/gpt-6.1-sol"]);
    expect(createReplyModels("/unused", options)).toHaveLength(2);
  });

  test("settings failure does not authorize fallback inference", async () => {
    let calls = 0;
    const models = createReplyModels("/unused", {
      readSettings: () => {
        throw new Error("Settings unavailable");
      },
      callNative: async () => {
        calls++;
        return "{}";
      },
    });
    expect(await interpretReply({ message: "继续", items: ITEMS, models })).toBeUndefined();
    expect(calls).toBe(0);
  });
});
