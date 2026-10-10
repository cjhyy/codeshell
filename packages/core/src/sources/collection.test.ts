import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import type { SourceDefinition } from "./types.js";
import type { ToolContext } from "../tool-system/context.js";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import { officeZip, wordXml } from "../../../../tests/fixtures/upload-documents.mjs";

const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
] as const;
const saved = surfaces.map(([object, key]) => ({
  object,
  key,
  descriptor: Object.getOwnPropertyDescriptor(object, key),
}));
installLocalNetworkGuard("http://127.0.0.1:9");
const ownedSurfaces = saved.map(({ object, key }) => Reflect.get(object, key));
afterAll(() => {
  if (
    saved.some(({ object, key }, index) => Reflect.get(object, key) !== ownedSurfaces[index]) ||
    Reflect.get(globalThis, marker) !== "http://127.0.0.1:9"
  )
    throw new Error("Collection fixture lost ownership of its network guard");
  for (const { object, key, descriptor } of saved) {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  }
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else Reflect.deleteProperty(globalThis, marker);
  syncBuiltinESMExports();
});
expect(() => fetch("https://collection.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
console.log(
  JSON.stringify({
    fixture: "collection-before-Core",
    pid: process.pid,
    ppid: process.ppid,
    homeSha256: createHash("sha256").update(realpathSync(process.env.HOME!)).digest("hex"),
    negativeProbes: 2,
  }),
);

const { CollectionConfigSchema, collectionConfig } = await import("./collection.js");
const { captureCollectionLocalFile, readCollectionLocalFile } =
  await import("./collection-local.js");
const {
  saveSourceDefinition,
  readSourceDefinition,
  deleteSourceDefinition,
  listSourceDefinitions,
} = await import("./catalog.js");
const { bindSource } = await import("./binding.js");
const { SettingsManager } = await import("../settings/manager.js");
const { saveWorkspaceProfile } = await import("../profile/store.js");
const { collectionAdapter } = await import("./adapters/collection.js");
const { listSourcesTool, readSourceTool, registerBuiltinSourceAdapters } =
  await import("../tool-system/builtin/sources.js");
const { registerConnectorAdapter } = await import("./adapter.js");
const { ToolExecutor } = await import("../tool-system/executor.js");
const { ToolRegistry } = await import("../tool-system/registry.js");
const { PermissionClassifier } = await import("../tool-system/permission.js");
const { HookRegistry } = await import("../hooks/registry.js");

let root: string;
let project: string;
let file: string;
let previousState: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "collection-source-")));
  project = join(root, "project-a");
  mkdirSync(project);
  previousState = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "state");
  file = join(root, "brief.txt");
  writeFileSync(file, "budget alpha document");
});
afterEach(() => {
  registerBuiltinSourceAdapters();
  if (previousState === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousState;
  rmSync(root, { recursive: true, force: true });
});
function definition(): SourceDefinition {
  return {
    id: "library",
    label: "Shared docs",
    kind: "collection",
    enabled: true,
    adapterConfig: {
      version: 1,
      revision: randomUUID(),
      entries: [captureCollectionLocalFile(file, "entry_a")],
    },
  };
}
function bind(cwd = project, scopes = ["entry_a"], policy: "ask" | "deny" = "ask") {
  bindSource(new SettingsManager(cwd, "project"), cwd, {
    sourceId: "library",
    scopes,
    readPolicy: policy,
  });
}
function context(cwd = project): ToolContext {
  return { cwd, settingsScope: "project" } as ToolContext;
}
function args(extra = {}) {
  return { source: "library", scope: "entry_a", resource: "entry_a", ...extra };
}

test("manifest is closed, bounded and per-file; mixed local/URL entries have distinct ids", () => {
  const config = collectionConfig(definition());
  const url = {
    id: "entry_url",
    name: "guide.pdf",
    kind: "url",
    url: "https://example.com/guide.pdf",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    checkedAt: new Date().toISOString(),
  };
  expect(
    CollectionConfigSchema.parse({ ...config, entries: [...config.entries, url] }).entries,
  ).toHaveLength(2);
  for (const entries of [
    [config.entries[0], config.entries[0]],
    [{ ...url, url: "http://example.com/guide.pdf" }],
    [{ ...url, url: "https://user:secret@example.com/a" }],
    [{ ...url, url: "https://example.com/a#fragment" }],
    [{ ...url, extra: true }],
    [{ ...config.entries[0], path: "relative.txt" }],
    Array.from({ length: 1001 }, (_, i) => ({ ...url, id: `entry_${i}` })),
  ])
    expect(CollectionConfigSchema.safeParse({ ...config, entries }).success).toBe(false);
});

test("capture references original bytes once; subsequent directory additions are not selected", async () => {
  const d = definition();
  expect(
    new TextDecoder().decode(readCollectionLocalFile(collectionConfig(d).entries[0] as any)),
  ).toBe("budget alpha document");
  writeFileSync(join(root, "new.txt"), "not selected");
  expect(await collectionAdapter.listScopes(d)).toEqual([{ id: "entry_a", label: "brief.txt" }]);
  expect(await collectionAdapter.listResources(d, "all")).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("budget alpha document");
});

test("changed bytes with restored size/mtime, replaced inode, missing file and symlink fail closed", () => {
  const entry = captureCollectionLocalFile(file, "entry_a");
  const before = statSync(file);
  writeFileSync(file, "budget bravo document");
  utimesSync(file, before.atime, before.mtime);
  expect(() => readCollectionLocalFile(entry)).toThrow("changed");
  const changed = captureCollectionLocalFile(file, "entry_a");
  expect(() => readCollectionLocalFile({ ...changed, sha256: entry.sha256 })).toThrow("changed");
  writeFileSync(file, "budget alpha document");
  const fresh = captureCollectionLocalFile(file, "entry_a");
  renameSync(file, join(root, "old.txt"));
  writeFileSync(file, "budget alpha document");
  expect(() => readCollectionLocalFile(fresh)).toThrow("changed");
  rmSync(file);
  expect(() => readCollectionLocalFile(fresh)).toThrow();
  if (process.platform !== "win32") {
    symlinkSync(join(root, "old.txt"), file);
    expect(() => readCollectionLocalFile(fresh)).toThrow();
    expect(() => captureCollectionLocalFile(file, "entry_a")).toThrow("symbolic link");
  }
});

test("capture/read enforce 20MiB and cancellation/revocation before returning bytes", () => {
  const entry = captureCollectionLocalFile(file, "entry_a");
  const controller = new AbortController();
  controller.abort(new Error("cancelled fixture"));
  expect(() => readCollectionLocalFile(entry, { signal: controller.signal })).toThrow(
    "cancelled fixture",
  );
  expect(() =>
    captureCollectionLocalFile(file, "entry_b", undefined, {
      assertAuthorized() {
        throw new Error("revoked fixture");
      },
    }),
  ).toThrow("revoked fixture");
  truncateSync(file, 20 * 1024 * 1024 + 1);
  expect(() => captureCollectionLocalFile(file, "entry_b")).toThrow("20 MiB");
});

test("collection create/update/delete CAS rejects stale revisions and existing non-collections", () => {
  const first = definition();
  saveSourceDefinition(first, { expectedCollectionRevision: null });
  const initial = collectionConfig(first).revision;
  expect(() => saveSourceDefinition(first, { expectedCollectionRevision: initial })).toThrow(
    "new revision",
  );
  expect(() => saveSourceDefinition(first, { expectedCollectionRevision: null })).toThrow(
    "revision conflict",
  );
  const second = {
    ...first,
    label: "Updated",
    adapterConfig: { ...first.adapterConfig, revision: randomUUID() },
  };
  saveSourceDefinition(second, { expectedCollectionRevision: initial });
  expect(() => saveSourceDefinition(first, { expectedCollectionRevision: initial })).toThrow(
    "revision conflict",
  );
  expect(() => deleteSourceDefinition(first.id, { expectedCollectionRevision: initial })).toThrow(
    "revision conflict",
  );
  expect(readSourceDefinition(first.id)?.label).toBe("Updated");
  deleteSourceDefinition(first.id, {
    expectedCollectionRevision: collectionConfig(second).revision,
  });
  saveSourceDefinition({
    id: "library",
    kind: "mock",
    label: "Old",
    adapterConfig: {},
    enabled: true,
  });
  expect(() => saveSourceDefinition(first, { expectedCollectionRevision: null })).toThrow(
    "revision conflict",
  );
});

test("actual concurrent processes cannot both replace the same collection revision", async () => {
  const first = definition();
  saveSourceDefinition(first, { expectedCollectionRevision: null });
  const revision = collectionConfig(first).revision;
  const children = ["one", "two"].map((label) => {
    const next = {
      ...first,
      label,
      adapterConfig: { ...first.adapterConfig, revision: randomUUID() },
    };
    const script = `
      const { installLocalNetworkGuard } = await import(${JSON.stringify(new URL("../../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url).href)});
      installLocalNetworkGuard("http://127.0.0.1:9");
      let denied = false;
      try { fetch("https://collection.invalid/"); } catch { denied = true; }
      if (!denied) throw new Error("Missing preimport guard");
      const { saveSourceDefinition } = await import(${JSON.stringify(new URL("./catalog.ts", import.meta.url).href)});
      try { saveSourceDefinition(${JSON.stringify(next)}, { expectedCollectionRevision: ${JSON.stringify(revision)} }); }
      catch (error) {
        if (error instanceof Error && error.message.includes("revision conflict")) process.exitCode = 3;
        else throw error;
      }
    `;
    return Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
  });
  const results = await Promise.all(
    children.map(async (child) => {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    }),
  );
  expect(results.map((result) => result.code).sort()).toEqual([0, 3]);
  expect(results.every((result) => result.stderr === "")).toBe(true);
  expect(["one", "two"]).toContain(readSourceDefinition(first.id)?.label);
});

test("malformed collection config is quarantined and CAS cannot replace it as a missing source", () => {
  mkdirSync(process.env.CODE_SHELL_HOME!, { recursive: true });
  writeFileSync(
    join(process.env.CODE_SHELL_HOME!, "sources.json"),
    JSON.stringify({
      version: 1,
      sources: [
        { ...definition(), adapterConfig: { version: 1, revision: "invalid", entries: [] } },
      ],
    }),
  );
  expect(listSourceDefinitions()).toEqual([]);
  expect(() => saveSourceDefinition(definition(), { expectedCollectionRevision: null })).toThrow();
});

test("two projects reuse the same file; empty scopes and a Profile allowlist remain closed", async () => {
  saveSourceDefinition(definition());
  bind();
  const sibling = join(root, "project-b");
  mkdirSync(sibling);
  bind(sibling);
  expect(await readSourceTool(args(), context())).toContain("budget alpha");
  expect(await readSourceTool(args(), context(sibling))).toContain("budget alpha");
  bind(sibling, []);
  expect(await readSourceTool(args(), context(sibling))).toContain("not bound");
  saveWorkspaceProfile({
    name: "closed",
    label: "Closed",
    basePreset: "general",
    sourceAccess: [],
  });
  expect(await readSourceTool(args(), { ...context(), workspaceProfileName: "closed" })).toContain(
    "not bound",
  );
  expect(readFileSync(file, "utf8")).toBe("budget alpha document");
});

test("listing is metadata only and newly selected files never expand existing project scopes", async () => {
  const d = definition();
  saveSourceDefinition(d);
  bind();
  const other = join(root, "other.txt");
  writeFileSync(other, "PRIVATE new contents");
  saveSourceDefinition(
    {
      ...d,
      adapterConfig: {
        ...d.adapterConfig,
        revision: randomUUID(),
        entries: [...collectionConfig(d).entries, captureCollectionLocalFile(other, "entry_b")],
      },
    },
    { expectedCollectionRevision: collectionConfig(d).revision },
  );
  const listing = await listSourcesTool({}, context());
  expect(listing).toContain("brief.txt");
  expect(listing).not.toContain("budget alpha");
  expect(listing).not.toContain("other.txt");
  expect(await readSourceTool(args({ resource: "entry_b" }), context())).toContain("not listed");
  expect(
    await readSourceTool(args({ scope: "entry_b", resource: "entry_b" }), context()),
  ).toContain("not bound");
});

test("1000-entry metadata projection does not dispatch 1000 adapter calls or read originals", async () => {
  const d = definition();
  const base = collectionConfig(d).entries[0]!;
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    ...base,
    id: `entry_${index}`,
    name: `doc-${index}.txt`,
  }));
  d.adapterConfig.entries = entries;
  saveSourceDefinition(d);
  bind(
    project,
    entries.map((entry) => entry.id),
  );
  rmSync(file); // Metadata remains inspectable; an actual read must still fail.
  const calls = spyOn(collectionAdapter, "listResources");
  try {
    const listing = await listSourcesTool({}, context());
    expect(listing.match(/resource: entry_/g)).toHaveLength(1000);
    expect(calls).toHaveBeenCalledTimes(0);
    expect(listing).not.toContain("budget alpha");
    bind(project, ["entry_0", "entry_999"]);
    const limited = await listSourcesTool({}, context());
    expect(limited.match(/resource: entry_/g)).toHaveLength(2);
    expect(limited).not.toContain("doc-500.txt");
  } finally {
    calls.mockRestore();
  }
});

test("actual parser uses the selected Office filename while queries/chunks retain stable resource ids", async () => {
  writeFileSync(file, officeZip({ "word/document.xml": wordXml("collection milestone budget") }));
  const d = definition();
  d.adapterConfig.entries = [captureCollectionLocalFile(file, "entry_a", "manual.docx")];
  saveSourceDefinition(d);
  bind();
  const query = await readSourceTool(args({ query: "milestone", limit: 1 }), context());
  expect(query).toContain('"format":"docx"');
  expect(query).toContain('"resourceId":"entry_a"');
  const chunkId = query.match(/"id":"(c_[a-f0-9]{24})"/)![1];
  expect(await readSourceTool(args({ chunk: chunkId }), context())).toContain(
    "collection milestone",
  );
  writeFileSync(file, "replaced");
  expect(await readSourceTool(args({ chunk: chunkId }), context())).toContain("changed");
});

test("explicit refresh preserves ids, invalidates old chunks and removal stops cached reads", async () => {
  const first = definition();
  saveSourceDefinition(first);
  bind();
  const query = await readSourceTool(args({ query: "budget" }), context());
  const oldChunk = query.match(/"id":"(c_[a-f0-9]{24})"/)![1];
  writeFileSync(file, "updated budget delta");
  const refreshed = {
    ...first,
    adapterConfig: {
      version: 1,
      revision: randomUUID(),
      entries: [captureCollectionLocalFile(file, "entry_a")],
    },
  };
  saveSourceDefinition(refreshed, { expectedCollectionRevision: collectionConfig(first).revision });
  expect(await readSourceTool(args(), context())).toContain("updated budget delta");
  expect(await readSourceTool(args({ chunk: oldChunk }), context())).toContain(
    "not in this file version",
  );
  deleteSourceDefinition(first.id, {
    expectedCollectionRevision: collectionConfig(refreshed).revision,
  });
  expect(await readSourceTool(args(), context())).toContain("dangling");
  expect(readFileSync(file, "utf8")).toBe("updated budget delta");
});

test("real ToolExecutor asks per file and rejects revocation while approval is pending", async () => {
  saveSourceDefinition(definition());
  bind();
  let prompts = 0;
  const permission = new PermissionClassifier([], "default", {
    async requestApproval(request) {
      prompts++;
      expect(request.toolName).toBe("ReadSource");
      if (prompts === 2) bind(project, ["entry_a"], "deny");
      return { approved: true };
    },
  });
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["ReadSource", "ListSources"] }),
    permission,
    new HookRegistry(),
  );
  executor.setContext(context());
  const first = await executor.executeSingle({ id: "first", toolName: "ReadSource", args: args() });
  expect(first.isError).toBe(false);
  expect(first.result).toContain("budget alpha");
  const second = await executor.executeSingle({
    id: "second",
    toolName: "ReadSource",
    args: args(),
  });
  expect(second.isError).toBe(true);
  expect(JSON.stringify(second)).not.toContain("budget alpha");
  expect(prompts).toBe(2);
});

test("manifest replacement during actual adapter read invalidates the awaited result", async () => {
  const d = definition();
  saveSourceDefinition(d);
  bind();
  registerConnectorAdapter({
    ...collectionAdapter,
    async read(...input) {
      saveSourceDefinition(
        { ...d, adapterConfig: { ...d.adapterConfig, revision: randomUUID() } },
        { expectedCollectionRevision: collectionConfig(d).revision },
      );
      return collectionAdapter.read(...input);
    },
  });
  const result = await readSourceTool(args(), context());
  expect(result).toContain("authorization changed");
  expect(result).not.toContain("budget alpha");
});
