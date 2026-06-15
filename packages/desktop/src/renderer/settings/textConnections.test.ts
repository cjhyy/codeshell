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
  uniqueInstanceId,
  credentialCandidates,
  credentialLabel,
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
