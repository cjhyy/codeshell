/**
 * genInstancesFromConnections — project unified modelConnections (tag=image or
 * video) + credentials into the {kind, baseUrl, apiKey, defaultModel} shape the
 * image/video runtime resolvers consume, so image/video also flow through the
 * unified credentials store. Key comes from the referenced credential.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §6.
 */
import { describe, test, expect } from "bun:test";
import { genInstancesFromConnections } from "./gen-connections.js";
import type { CatalogEntry } from "./types.js";
import type { ModelInstance, Credential } from "./resolve.js";

const CATALOG: CatalogEntry[] = [
  {
    id: "openai-images",
    tag: "image",
    adapterKind: "openai",
    displayName: "OpenAI Images",
    description: "x",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
  },
  {
    id: "fal-video",
    tag: "video",
    adapterKind: "fal",
    displayName: "fal",
    description: "x",
    defaultBaseUrl: "https://queue.fal.run",
  },
];

const CREDS: Credential[] = [
  { id: "openai-acct", catalogId: "openai-images", apiKey: "sk-img" },
  { id: "fal-acct", catalogId: "fal-video", apiKey: "sk-fal" },
];

describe("genInstancesFromConnections", () => {
  test("projects image connections to {id, kind, baseUrl, apiKey, defaultModel}", () => {
    const conns: ModelInstance[] = [
      { id: "img1", catalogId: "openai-images", tag: "image", model: "gpt-image-2", credentialId: "openai-acct" },
    ];
    const out = genInstancesFromConnections(conns, CREDS, CATALOG, "image");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "img1",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-img",
      defaultModel: "gpt-image-2",
    });
  });

  test("filters by tag (image vs video)", () => {
    const conns: ModelInstance[] = [
      { id: "img1", catalogId: "openai-images", tag: "image", model: "m", credentialId: "openai-acct" },
      { id: "vid1", catalogId: "fal-video", tag: "video", model: "m", credentialId: "fal-acct" },
    ];
    expect(genInstancesFromConnections(conns, CREDS, CATALOG, "image").map((i) => i.id)).toEqual(["img1"]);
    expect(genInstancesFromConnections(conns, CREDS, CATALOG, "video").map((i) => i.id)).toEqual(["vid1"]);
  });

  test("key comes from the credential; connections sharing one credential share the key", () => {
    const conns: ModelInstance[] = [
      { id: "a", catalogId: "openai-images", tag: "image", model: "m", credentialId: "openai-acct" },
      { id: "b", catalogId: "openai-images", tag: "image", model: "m2", credentialId: "openai-acct" },
    ];
    const out = genInstancesFromConnections(conns, CREDS, CATALOG, "image");
    expect(out.every((i) => i.apiKey === "sk-img")).toBe(true);
  });

  test("connection model overrides the catalog defaultModel", () => {
    const conns: ModelInstance[] = [
      { id: "a", catalogId: "openai-images", tag: "image", model: "dall-e-3", credentialId: "openai-acct" },
    ];
    expect(genInstancesFromConnections(conns, CREDS, CATALOG, "image")[0]!.defaultModel).toBe("dall-e-3");
  });

  test("unknown catalogId connection is skipped", () => {
    const conns: ModelInstance[] = [
      { id: "ok", catalogId: "openai-images", tag: "image", model: "m", credentialId: "openai-acct" },
      { id: "bad", catalogId: "ghost", tag: "image", model: "m", credentialId: "openai-acct" },
    ];
    expect(genInstancesFromConnections(conns, CREDS, CATALOG, "image").map((i) => i.id)).toEqual(["ok"]);
  });
});
