import { expect, test } from "bun:test";
import { resolvePanelConnections, panelConnectionIds } from "./connections.js";
import type { CatalogEntry } from "@cjhyy/code-shell-core/internal";
const catalog: CatalogEntry[] = [
  {
    id: "test-provider",
    displayName: "Test",
    tag: "speech",
    adapterKind: "openai",
    defaultBaseUrl: "https://example.test/v1",
    modelPresets: [
      {
        value: "test-tts",
        params: [{ name: "voice", control: "enum", options: ["test"], default: "test" }],
      },
    ],
  },
];
const settings = {
  modelConnections: [
    {
      id: "selected",
      catalogId: "test-provider",
      tag: "speech",
      model: "test-tts",
      credentialId: "key-a",
      paramValues: { voice: "test" },
    },
    {
      id: "other",
      catalogId: "test-provider",
      tag: "speech",
      model: "test-tts",
      credentialId: "key-b",
    },
  ],
  credentials: [
    { id: "key-a", catalogId: "test-provider", apiKey: "test-selected-secret" },
    { id: "key-b", catalogId: "test-provider", apiKey: "test-unselected-secret" },
  ],
  defaults: { speech: "selected" },
};
test("generic public connection discovery excludes credentials", () => {
  const value = resolvePanelConnections(settings as never, catalog);
  expect(value.connections.length).toBe(2);
  expect(JSON.stringify(value)).not.toContain("test-selected-secret");
  expect(JSON.stringify(value)).not.toContain("test-unselected-secret");
  expect(value.connections[0]!.id).toBe("selected");
});
test("sealed resolution includes only explicitly selected connection secrets", () => {
  const value = resolvePanelConnections(settings as never, catalog, ["selected"]);
  expect(value.connections.map((connection) => connection.id)).toEqual(["selected"]);
  expect(JSON.stringify(value)).toContain("test-selected-secret");
  expect(JSON.stringify(value)).not.toContain("test-unselected-secret");
  expect(() => resolvePanelConnections(settings as never, catalog, ["missing"])).toThrow(
    "unavailable",
  );
});
test("connection selection rejects empty, duplicate and unbounded lists", () => {
  for (const value of [[], ["same", "same"], new Array(9).fill("x"), [null], [""]])
    expect(() => panelConnectionIds(value)).toThrow();
});

test("public connection discovery strips URL credentials and arbitrary parameter secrets", () => {
  const privateSettings = structuredClone(settings);
  Object.assign(privateSettings.modelConnections[0]!, {
    baseUrl: "https://name:password@example.test/v1?token=query-secret",
    paramValues: {
      voice: "test",
      headers: { Authorization: "Bearer header-secret" },
      instructions: "text-secret",
      apiKey: "param-secret",
    },
  });
  const value = resolvePanelConnections(privateSettings as never, catalog);
  expect(value.connections[0]!.fingerprint).toMatch(/^[a-f0-9]{32}$/);
  expect(value.connections[0]!.baseUrl).toBeUndefined();
  expect(value.connections[0]!.paramValues).toEqual({ voice: "test" });
  for (const secret of ["password", "query-secret", "header-secret", "text-secret", "param-secret"])
    expect(JSON.stringify(value)).not.toContain(secret);
});

test("public connection metadata filters declared secrets and only exposes typed UI values", () => {
  const privateCatalog = structuredClone(catalog);
  const preset = privateCatalog[0]!.modelPresets![0]!;
  preset.params!.push(
    { name: "instructions", control: "text", default: "private text default" },
    { name: "requestHeaders", control: "text", default: "private header default" },
    { name: "token", control: "enum", options: ["private enum token"] },
    { name: "speed", control: "number", min: 0.5, max: 2, default: 1 },
    { name: "normalize", control: "toggle", default: true },
  );
  const privateSettings = structuredClone(settings);
  Object.assign(privateSettings.modelConnections[0]!, {
    paramValues: {
      voice: "unlisted private voice",
      instructions: "private instruction value",
      requestHeaders: "private header value",
      token: "private enum token",
      speed: 1.25,
      normalize: false,
    },
  });
  const publicValue = resolvePanelConnections(privateSettings as never, privateCatalog);
  const connection = publicValue.connections[0]!;
  expect(connection.paramValues).toEqual({ speed: 1.25, normalize: false });
  expect(connection.entry).toEqual({ displayName: "Test", tag: "speech" });
  expect(connection.preset.params).toContainEqual({ name: "instructions", control: "text" });
  expect(connection.preset.params).toContainEqual({
    name: "speed",
    control: "number",
    min: 0.5,
    max: 2,
    default: 1,
  });
  expect(JSON.stringify(publicValue)).not.toContain("private");

  const sealed = resolvePanelConnections(privateSettings as never, privateCatalog, ["selected"]);
  expect(sealed.connections[0]!.paramValues).toMatchObject({
    instructions: "private instruction value",
    requestHeaders: "private header value",
  });
  expect(sealed.connections[0]!.apiKey).toBe("test-selected-secret");
});

test("connection fingerprints detect endpoint changes without disclosing their contents", () => {
  const before = resolvePanelConnections(settings as never, catalog);
  const changedSettings = structuredClone(settings);
  Object.assign(changedSettings.modelConnections[0]!, {
    baseUrl: "https://endpoint-secret@example.test/new-private-path?key=query-secret",
  });
  const after = resolvePanelConnections(changedSettings as never, catalog);
  expect(after.connections[0]!.fingerprint).not.toBe(before.connections[0]!.fingerprint);
  expect(after.connections[1]!.fingerprint).toBe(before.connections[1]!.fingerprint);
  expect(JSON.stringify(after)).not.toContain("endpoint-secret");
  expect(JSON.stringify(after)).not.toContain("new-private-path");
  expect(JSON.stringify(after)).not.toContain("query-secret");
});
