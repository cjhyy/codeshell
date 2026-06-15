/**
 * resolveInstance — turn a stored ModelInstance + credentials + catalog into
 * the runtime shape any capability entry (chat / GenerateImage / GenerateVideo)
 * consumes. The key comes from the referenced credential (credentialId), not
 * from the connection itself.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, expect } from "bun:test";
import { resolveInstance } from "./resolve.js";
import type { CatalogEntry } from "./types.js";
import type { ModelInstance, Credential } from "./resolve.js";

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
      {
        value: "gpt-5.5",
        params: [{ name: "reasoning", control: "enum", options: ["low", "high"], wire: { field: "reasoning_effort" } }],
      },
      { value: "gpt-4o" },
    ],
  },
];

const CREDS: Credential[] = [
  { id: "openai-acct", catalogId: "openai", apiKey: "sk-shared" },
];

describe("resolveInstance", () => {
  test("resolves entry/adapterKind/preset/paramValues + key from credential", () => {
    const inst: ModelInstance = {
      id: "a",
      catalogId: "openai",
      tag: "text",
      model: "gpt-5.5",
      credentialId: "openai-acct",
      paramValues: { reasoning: "high" },
    };
    const r = resolveInstance(inst, CREDS, CATALOG);
    expect(r).not.toBeNull();
    expect(r!.entry.id).toBe("openai");
    expect(r!.adapterKind).toBe("openai");
    expect(r!.apiKey).toBe("sk-shared");
    expect(r!.preset?.value).toBe("gpt-5.5");
    expect(r!.paramValues).toEqual({ reasoning: "high" });
    expect(r!.baseUrl).toBe("https://api.openai.com/v1"); // entry default
  });

  test("multiple connections sharing one credential both resolve the same key", () => {
    const a: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-5.5", credentialId: "openai-acct" };
    const b: ModelInstance = { id: "b", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "openai-acct" };
    expect(resolveInstance(a, CREDS, CATALOG)!.apiKey).toBe("sk-shared");
    expect(resolveInstance(b, CREDS, CATALOG)!.apiKey).toBe("sk-shared");
  });

  test("credential baseUrl is used when set; connection baseUrl overrides it", () => {
    const creds: Credential[] = [{ id: "c", catalogId: "openai", apiKey: "k", baseUrl: "https://cred/v1" }];
    const fromCred: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "c" };
    expect(resolveInstance(fromCred, creds, CATALOG)!.baseUrl).toBe("https://cred/v1");
    const override: ModelInstance = { ...fromCred, baseUrl: "https://conn/v1" };
    expect(resolveInstance(override, creds, CATALOG)!.baseUrl).toBe("https://conn/v1");
  });

  test("unknown catalogId returns null", () => {
    const inst: ModelInstance = { id: "a", catalogId: "nope", tag: "text", model: "m", credentialId: "openai-acct" };
    expect(resolveInstance(inst, CREDS, CATALOG)).toBeNull();
  });

  test("missing credential yields no key (not a crash)", () => {
    const inst: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-4o", credentialId: "ghost" };
    expect(resolveInstance(inst, CREDS, CATALOG)!.apiKey).toBeUndefined();
  });

  test("no credentialId at all → no key", () => {
    const inst: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-4o" };
    expect(resolveInstance(inst, CREDS, CATALOG)!.apiKey).toBeUndefined();
  });

  test("preset is undefined when the model isn't in modelPresets (still resolves)", () => {
    const inst: ModelInstance = { id: "a", catalogId: "openai", tag: "text", model: "gpt-9-unknown", credentialId: "openai-acct" };
    const r = resolveInstance(inst, CREDS, CATALOG);
    expect(r!.preset).toBeUndefined();
    expect(r!.entry.id).toBe("openai");
  });
});
