/**
 * Pure logic for the text connection panel: build a ModelInstance from a
 * catalog template + picked model, generate a unique id, and list credential
 * candidates (a connection references a Credential by id; key lives on the
 * credential, not the connection — so deleting a connection never loses a key).
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3.
 */
import { describe, test, expect } from "bun:test";
import type { CatalogEntry } from "../../preload/types";
import {
  buildTextInstance,
  buildInstance,
  uniqueInstanceId,
  credentialCandidates,
  credentialLabel,
  catalogModelOptions,
  type ModelInstance,
  type Credential,
} from "./textConnections";

const OPENAI: CatalogEntry = {
  id: "openai",
  tag: "text",
  adapterKind: "openai",
  protocol: "openai-compat",
  displayName: "OpenAI",
  description: "x",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5.5",
  needsKey: true,
  modelPresets: [
    {
      value: "gpt-5.5",
      params: [{ name: "reasoning", control: "enum", options: ["low", "high"], default: "low" }],
    },
  ],
};

describe("uniqueInstanceId", () => {
  test("uses the catalog id when free", () => {
    expect(uniqueInstanceId("openai", new Set())).toBe("openai");
  });
  test("suffixes on collision", () => {
    expect(uniqueInstanceId("openai", new Set(["openai"]))).toBe("openai-2");
    expect(uniqueInstanceId("openai", new Set(["openai", "openai-2"]))).toBe("openai-3");
  });
});

describe("buildTextInstance", () => {
  test("builds a tag=text instance pointing at the catalog entry", () => {
    const inst = buildTextInstance(OPENAI, "gpt-5.5", new Set());
    expect(inst.tag).toBe("text");
    expect(inst.catalogId).toBe("openai");
    expect(inst.model).toBe("gpt-5.5");
  });

  test("seeds paramValues from the preset's param defaults", () => {
    const inst = buildTextInstance(OPENAI, "gpt-5.5", new Set());
    expect(inst.paramValues).toEqual({ reasoning: "low" });
  });

  test("falls back to entry.defaultModel when no model given", () => {
    expect(buildTextInstance(OPENAI, undefined, new Set()).model).toBe("gpt-5.5");
  });

  test("does not inline a key on the connection", () => {
    const inst = buildTextInstance(OPENAI, "gpt-5.5", new Set());
    expect((inst as { apiKey?: string }).apiKey).toBeUndefined();
  });

  test("uses a model-specific id for a second connection on the same provider", () => {
    const DEEPSEEK: CatalogEntry = {
      id: "deepseek",
      tag: "text",
      adapterKind: "deepseek",
      protocol: "openai-compat",
      displayName: "DeepSeek",
      description: "x",
      defaultBaseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-v4-flash",
      modelPresets: [
        { value: "deepseek-v4-flash" },
        { value: "deepseek-v4-pro" },
      ],
    };
    const inst = buildTextInstance(DEEPSEEK, "deepseek-v4-pro", new Set(["deepseek"]));
    expect(inst).toMatchObject({
      id: "deepseek-v4-pro",
      catalogId: "deepseek",
      model: "deepseek-v4-pro",
    });
  });
});

describe("buildInstance (any tag)", () => {
  const IMG: CatalogEntry = {
    id: "openai-images",
    tag: "image",
    adapterKind: "openai",
    displayName: "OpenAI Images",
    description: "x",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
  };
  test("builds an image-tagged instance", () => {
    const inst = buildInstance(IMG, "gpt-image-2", new Set(), "image");
    expect(inst.tag).toBe("image");
    expect(inst.catalogId).toBe("openai-images");
    expect(inst.model).toBe("gpt-image-2");
  });
  test("buildTextInstance is the tag=text specialization", () => {
    expect(buildTextInstance(OPENAI, "gpt-5.5", new Set()).tag).toBe("text");
  });
});

describe("credentialCandidates", () => {
  const creds: Credential[] = [
    { id: "openai-acct", catalogId: "openai", apiKey: "sk-1" },
    { id: "openai-acct-2", catalogId: "openai", apiKey: "sk-2" },
    { id: "anth-acct", catalogId: "anthropic", apiKey: "sk-3" },
  ];
  test("lists credentials for the same catalogId", () => {
    const cands = credentialCandidates(creds, "openai");
    expect(cands.map((c) => c.id)).toEqual(["openai-acct", "openai-acct-2"]);
  });
  test("excludes other-catalog credentials (a key belongs to one provider account)", () => {
    expect(credentialCandidates(creds, "openai").some((c) => c.id === "anth-acct")).toBe(false);
  });

  test("with catalog: shares a key across same-provider catalogIds (openai key → openai-transcribe)", () => {
    // Regression: adding a voice connection (openai-transcribe) showed NO existing
    // key even though an OpenAI text key was saved, because the old filter matched
    // catalogId exactly. Now same adapterKind (openai) shares.
    const catalog: CatalogEntry[] = [
      OPENAI, // id "openai", adapterKind "openai"
      {
        id: "openai-transcribe",
        tag: "audio",
        adapterKind: "openai",
        displayName: "OpenAI 语音转写",
        description: "x",
        defaultBaseUrl: "https://api.openai.com/v1",
      },
      {
        id: "anthropic",
        tag: "text",
        adapterKind: "anthropic",
        displayName: "Anthropic",
        description: "x",
        defaultBaseUrl: "https://api.anthropic.com",
      },
    ];
    const cands = credentialCandidates(creds, "openai-transcribe", catalog);
    // the two openai-account keys are candidates; the anthropic one is not.
    expect(cands.map((c) => c.id).sort()).toEqual(["openai-acct", "openai-acct-2"]);
    expect(cands.some((c) => c.id === "anth-acct")).toBe(false);
  });

  test("without catalog: falls back to exact catalogId (no accidental over-sharing)", () => {
    // openai-transcribe with no catalog → can't resolve adapterKind → exact match
    // only, so it sees no "openai"-catalogId creds (safe default).
    expect(credentialCandidates(creds, "openai-transcribe")).toEqual([]);
  });
});

describe("credentialLabel", () => {
  test("shows the connection/provider name + #id + last 4 of the key (not a model)", () => {
    const cred: Credential = { id: "openai-acct", catalogId: "openai", apiKey: "sk-secret-a1b2" };
    const label = credentialLabel(cred, "OpenAI");
    expect(label).toContain("OpenAI");
    expect(label).toContain("#openai-acct");
    expect(label).toContain("a1b2");
  });
  test("omits the key suffix when the credential has no key yet", () => {
    const label = credentialLabel({ id: "c", catalogId: "openai" }, "OpenAI");
    expect(label).not.toContain("⋯");
  });
});

describe("catalogModelOptions", () => {
  const DEEPSEEK: CatalogEntry = {
    id: "deepseek",
    tag: "text",
    adapterKind: "openai",
    displayName: "DeepSeek",
    description: "x",
    defaultBaseUrl: "https://api.deepseek.com",
    modelPresets: [
      { value: "deepseek-v4-flash", label: "V4 Flash", maxContextTokens: 128000, supportsVision: true },
    ],
  };
  const conns: ModelInstance[] = [
    { id: "openai", catalogId: "openai", tag: "text", model: "gpt-5.5" },
    { id: "deepseek", catalogId: "deepseek", tag: "text", model: "deepseek-v4-flash" },
    { id: "fal-video", catalogId: "fal-video", tag: "video", model: "x" },
    { id: "ghost", catalogId: "no-such", tag: "text", model: "y" },
  ];

  test("keys by instance id and chips with the catalog displayName, not catalogId", () => {
    const opts = catalogModelOptions(conns, [OPENAI, DEEPSEEK]);
    const openai = opts.find((o) => o.key === "openai");
    expect(openai?.provider).toBe("OpenAI");
    expect(openai?.label).toBe("gpt-5.5"); // OPENAI preset has no label → model id
  });
  test("pulls label/vision/context from the matching preset", () => {
    const ds = catalogModelOptions(conns, [OPENAI, DEEPSEEK]).find((o) => o.key === "deepseek");
    expect(ds).toMatchObject({ label: "V4 Flash", supportsVision: true, maxContextTokens: 128000 });
  });
  test("drops non-text instances and instances whose catalogId doesn't resolve", () => {
    const keys = catalogModelOptions(conns, [OPENAI, DEEPSEEK]).map((o) => o.key);
    expect(keys).toEqual(["openai", "deepseek"]); // no fal-video, no ghost
  });
});
