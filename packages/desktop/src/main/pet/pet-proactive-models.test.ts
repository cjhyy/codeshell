import { describe, expect, test } from "bun:test";
import { createReplyModels } from "./pet-notice-reply-models.js";
import { askModels, parseJsonObject } from "./pet-proactive-models.js";

function settings(model: string) {
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
    sessionDefaults: { model },
  } as never;
}

const QUESTION = { systemPrompt: "Return JSON", user: "Current facts", parse: parseJsonObject };

describe("proactive provider snapshots", () => {
  test("resolves one fresh factory per question and pins native fallback across a settings change", async () => {
    let current = settings("main");
    let snapshots = 0;
    const native: string[] = [];
    const external: string[] = [];
    const models = () => {
      snapshots++;
      return createReplyModels("/unused", {
        readSettings: () => current,
        callNative: async (config) => {
          native.push(config.model);
          current = settings("codex/gpt-6.1-sol");
          return config.model === "gpt-4o-mini" ? "invalid" : '{"native":true}';
        },
        external: async (selected) => {
          external.push(selected);
          return '{"external":true}';
        },
      });
    };
    expect(snapshots).toBe(0);
    expect(await askModels({ ...QUESTION, models })).toEqual({ native: true });
    expect(snapshots).toBe(1);
    expect(native).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(external).toEqual([]);
    expect(await askModels({ ...QUESTION, models })).toEqual({ external: true });
    expect(snapshots).toBe(2);
    expect(native).toHaveLength(2);
    expect(external).toEqual(["codex/gpt-6.1-sol"]);
  });

  test.each(["unavailable", "throws", "invalid", "timeout"])(
    "external %s cannot admit a native candidate even if settings change in flight",
    async (failure) => {
      let current = settings("claude-code/sonnet");
      let nativeCalls = 0;
      let snapshots = 0;
      let aborted = false;
      const result = await askModels({
        ...QUESTION,
        timeoutMs: 5,
        models: () => {
          snapshots++;
          return createReplyModels("/unused", {
            readSettings: () => current,
            callNative: async () => {
              nativeCalls++;
              return '{"native":true}';
            },
            ...(failure === "unavailable"
              ? {}
              : {
                  external: async (_selected, { signal }) => {
                    current = settings("main");
                    if (failure === "throws") throw new Error("External quota unavailable");
                    if (failure === "timeout") {
                      return new Promise<string>((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                          aborted = true;
                          reject(new Error("External stopped"));
                        });
                      });
                    }
                    return "invalid";
                  },
                }),
          });
        },
      });
      expect(result).toBeUndefined();
      expect(nativeCalls).toBe(0);
      expect(snapshots).toBe(1);
      expect(aborted).toBe(failure === "timeout");
    },
  );

  test("a model-source failure reports no judgement without authorizing another source", async () => {
    const errors: unknown[] = [];
    expect(
      await askModels({
        ...QUESTION,
        models: () => {
          throw new Error("Settings unavailable");
        },
        onError: (error) => errors.push(error),
      }),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
