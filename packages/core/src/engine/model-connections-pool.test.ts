/**
 * L6b engine consumption — the engine loads settings.modelConnections[] into
 * the model pool, so the unified instance store actually drives which model
 * sends requests. modelEntriesFromConnections is the pure bridge: connections +
 * credentials + catalog → ModelEntry[] (key from credential, protocol resolved,
 * paramValues.reasoning mapped to the entry's reasoning field).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, it, expect } from "bun:test";
import { modelEntriesFromConnections } from "./model-connections-pool.js";
import { ModelPool } from "../llm/model-pool.js";
import { validateSettings } from "../settings/schema.js";
import type { CatalogEntry } from "../model-catalog/index.js";
import type { ModelInstance, Credential } from "../model-catalog/resolve.js";

const CATALOG: CatalogEntry[] = [
  {
    id: "openai",
    tag: "text",
    adapterKind: "openai",
    protocol: "openai-compat",
    displayName: "OpenAI",
    description: "x",
    defaultBaseUrl: "https://api.openai.com/v1",
    modelPresets: [
      { value: "gpt-5.5", maxContextTokens: 400000, maxOutputTokens: 128000 },
      { value: "gpt-4o" },
    ],
  },
  {
    id: "openrouter",
    tag: "text",
    adapterKind: "openrouter",
    protocol: "openai-compat",
    displayName: "OpenRouter",
    description: "x",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    modelPresets: [{ value: "anthropic/claude-opus-4.8" }],
  },
  {
    id: "anthropic",
    tag: "text",
    adapterKind: "anthropic",
    protocol: "anthropic-style",
    displayName: "Anthropic",
    description: "x",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    modelPresets: [{ value: "claude-opus-4-7" }],
  },
];

const CREDS: Credential[] = [
  { id: "openai-acct", catalogId: "openai", apiKey: "sk-1" },
  { id: "anth-acct", catalogId: "anthropic", apiKey: "sk-2" },
  {
    id: "openrouter-acct",
    catalogId: "openrouter",
    apiKey: "sk-or-1",
    baseUrl: "https://openrouter.ai/api/v1",
  },
];

describe("modelEntriesFromConnections", () => {
  test("maps a text connection to a ModelEntry keyed by instance id, key from credential", () => {
    const insts: ModelInstance[] = [
      {
        id: "my-gpt5",
        catalogId: "openai",
        tag: "text",
        model: "gpt-5.5",
        credentialId: "openai-acct",
      },
    ];
    const entries = modelEntriesFromConnections(insts, CREDS, CATALOG);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.key).toBe("my-gpt5");
    expect(e.model).toBe("gpt-5.5");
    expect(e.apiKey).toBe("sk-1");
    expect(e.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("only text connections become model-pool entries (image/video excluded)", () => {
    const insts: ModelInstance[] = [
      { id: "t", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "openai-acct" },
      {
        id: "img",
        catalogId: "openai-images",
        tag: "image",
        model: "gpt-image-2",
        credentialId: "openai-acct",
      },
    ];
    const entries = modelEntriesFromConnections(insts, CREDS, CATALOG);
    expect(entries.map((e) => e.key)).toEqual(["t"]);
  });

  test("protocol comes from the catalog entry (openai vs anthropic)", () => {
    const insts: ModelInstance[] = [
      { id: "o", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "openai-acct" },
      {
        id: "a",
        catalogId: "anthropic",
        tag: "text",
        model: "claude-opus-4-7",
        credentialId: "anth-acct",
      },
    ];
    const entries = modelEntriesFromConnections(insts, CREDS, CATALOG);
    expect(entries.find((e) => e.key === "o")!.provider).toBe("openai");
    expect(entries.find((e) => e.key === "a")!.provider).toBe("anthropic");
  });

  test("providerKind comes from the catalog entry for openai-compatible gateways", () => {
    const insts: ModelInstance[] = [
      {
        id: "or",
        catalogId: "openrouter",
        tag: "text",
        model: "anthropic/claude-opus-4.8",
        credentialId: "openrouter-acct",
      },
    ];
    const e = modelEntriesFromConnections(insts, CREDS, CATALOG)[0]!;
    expect(e.provider).toBe("openai");
    expect(e.providerKind).toBe("openrouter");

    const pool = new ModelPool();
    expect(pool.toLLMConfig(e).providerKind).toBe("openrouter");
  });

  test("connections sharing one credential both get its key", () => {
    const insts: ModelInstance[] = [
      { id: "x", catalogId: "openai", tag: "text", model: "gpt-5.5", credentialId: "openai-acct" },
      { id: "y", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "openai-acct" },
    ];
    const entries = modelEntriesFromConnections(insts, CREDS, CATALOG);
    expect(entries.find((e) => e.key === "x")!.apiKey).toBe("sk-1");
    expect(entries.find((e) => e.key === "y")!.apiKey).toBe("sk-1");
  });

  test("carries token limits from the matched preset", () => {
    const insts: ModelInstance[] = [
      { id: "g", catalogId: "openai", tag: "text", model: "gpt-5.5", credentialId: "openai-acct" },
    ];
    const e = modelEntriesFromConnections(insts, CREDS, CATALOG)[0]!;
    expect(e.maxContextTokens).toBe(400000);
    expect(e.maxOutputTokens).toBe(128000);
  });

  test("paramValues.reasoning enum → ModelEntry.reasoning effort", () => {
    const insts: ModelInstance[] = [
      {
        id: "g",
        catalogId: "openai",
        tag: "text",
        model: "gpt-5.5",
        credentialId: "openai-acct",
        paramValues: { reasoning: "high" },
      },
    ];
    const e = modelEntriesFromConnections(insts, CREDS, CATALOG)[0]!;
    expect(e.reasoning).toEqual({ mode: "effort", effort: "high" });
  });

  test("paramValues.reasoning number → ModelEntry.reasoning budget", () => {
    const insts: ModelInstance[] = [
      {
        id: "c",
        catalogId: "anthropic",
        tag: "text",
        model: "claude-opus-4-7",
        credentialId: "anth-acct",
        paramValues: { reasoning: 8192 },
      },
    ];
    const e = modelEntriesFromConnections(insts, CREDS, CATALOG)[0]!;
    expect(e.reasoning).toEqual({ mode: "budget", budgetTokens: 8192 });
  });

  test("paramValues.reasoning boolean → ModelEntry.reasoning on/off", () => {
    const on: ModelInstance[] = [
      {
        id: "d",
        catalogId: "openai",
        tag: "text",
        model: "gpt-4o",
        credentialId: "openai-acct",
        paramValues: { reasoning: true },
      },
    ];
    expect(modelEntriesFromConnections(on, CREDS, CATALOG)[0]!.reasoning).toEqual({ mode: "on" });
    const off: ModelInstance[] = [
      {
        id: "d",
        catalogId: "openai",
        tag: "text",
        model: "gpt-4o",
        credentialId: "openai-acct",
        paramValues: { reasoning: false },
      },
    ];
    expect(modelEntriesFromConnections(off, CREDS, CATALOG)[0]!.reasoning).toEqual({ mode: "off" });
  });

  test("no paramValues → no reasoning on the entry", () => {
    const insts: ModelInstance[] = [
      { id: "g", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "openai-acct" },
    ];
    expect(modelEntriesFromConnections(insts, CREDS, CATALOG)[0]!.reasoning).toBeUndefined();
  });

  test("paramValues.reasoning UNKNOWN effort round-trips AND survives validateSettings (boot path)", () => {
    // The exact boot-crash: a connection picked an effort level the schema didn't
    // know ("xhigh"/"max"); the mapped reasoning then flows through the settings
    // models[] bridge into validateSettings at boot. Map must preserve it verbatim
    // and validateSettings must accept it (effort is free-form, catalog-driven).
    for (const effort of ["xhigh", "max"]) {
      const insts: ModelInstance[] = [
        {
          id: "g",
          catalogId: "openai",
          tag: "text",
          model: "gpt-5.5",
          credentialId: "openai-acct",
          paramValues: { reasoning: effort },
        },
      ];
      const e = modelEntriesFromConnections(insts, CREDS, CATALOG)[0]!;
      expect(e.reasoning).toEqual({ mode: "effort", effort });
      // The bridged reasoning carried on a settings models[] entry must validate.
      expect(() =>
        validateSettings({ models: [{ key: e.key, model: e.model, reasoning: e.reasoning }] }),
      ).not.toThrow();
    }
  });

  test("connection with an unknown catalogId is skipped (not a crash)", () => {
    const insts: ModelInstance[] = [
      { id: "ok", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "openai-acct" },
      { id: "bad", catalogId: "ghost", tag: "text", model: "m", credentialId: "openai-acct" },
    ];
    const entries = modelEntriesFromConnections(insts, CREDS, CATALOG);
    expect(entries.map((e) => e.key)).toEqual(["ok"]);
  });
});

const catalogP1 = [
  {
    id: "zhipu-p1",
    tag: "text",
    adapterKind: "openai",
    protocol: "openai-compat",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2",
    modelPresets: [
      {
        value: "glm-5.2",
        label: "GLM-5.2",
        params: [
          { name: "reasoning", control: "enum", wire: { field: "reasoning_effort" } },
          { name: "thinking_type", control: "enum", wire: { field: "thinking.type" } },
          { name: "temperature", control: "number", wire: { field: "temperature" } },
          { name: "top_p", control: "number", wire: { field: "top_p" } },
        ],
      },
    ],
  },
] as never;
const credsP1 = [
  {
    id: "z-key",
    catalogId: "zhipu-p1",
    apiKey: "k",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
] as never;

describe("modelEntriesFromConnections flows non-reasoning params to extraBody", () => {
  it("maps paramValues to extraBody via wire.field; reasoning stays separate", () => {
    const conns = [
      {
        id: "z",
        catalogId: "zhipu-p1",
        tag: "text",
        model: "glm-5.2",
        credentialId: "z-key",
        paramValues: { reasoning: "high", thinking_type: "enabled", temperature: 1, top_p: 0.95 },
      },
    ] as never;
    const [e] = modelEntriesFromConnections(conns, credsP1, catalogP1);
    expect(e.reasoning).toEqual({ mode: "effort", effort: "high" });
    expect(e.extraBody).toEqual({ thinking: { type: "enabled" }, temperature: 1, top_p: 0.95 });
    expect((e.extraBody as any)?.reasoning_effort).toBeUndefined();
  });
  it("no params → no extraBody", () => {
    const conns = [
      { id: "z2", catalogId: "zhipu-p1", tag: "text", model: "glm-5.2", credentialId: "z-key" },
    ] as never;
    const [e] = modelEntriesFromConnections(conns, credsP1, catalogP1);
    expect(e.extraBody).toBeUndefined();
  });
});
