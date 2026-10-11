import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

// Only synthetic documents are opened. All enumerated outbound JS transports
// are denied before importing compiled Core or the Desktop service. This is a
// process guard, not an OS sandbox; no model/provider is instantiated.
const surfaces = [[globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"], [net, "connect"], [net, "createConnection"],
  [net.Socket.prototype, "connect"], [tls, "connect"], [tls.TLSSocket.prototype, "connect"]] as const;
const saved = surfaces.map(([object, key]) => ({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key) }));
const attempts: string[] = [];
const owned = saved.map(({ object, key }, i) => {
  const deny = () => { attempts.push(`${i}:${key}`); throw new Error("round6 fixture denied outbound network"); };
  Reflect.set(object, key, deny);
  return deny;
});
syncBuiltinESMExports();
for (const probe of [() => fetch("https://outside.invalid/"), () => http.request("http://127.0.0.1:9/"),
  () => https.request("https://outside.invalid/"), () => net.connect(9, "127.0.0.1"),
  () => tls.connect(443, "outside.invalid")]) expect(probe).toThrow("denied outbound");

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const dist = `${workspace}/packages/core/dist`;
const { ToolExecutor } = await import(`${dist}/tool-system/executor.js`);
const { ToolRegistry } = await import(`${dist}/tool-system/registry.js`);
const { PermissionClassifier } = await import(`${dist}/tool-system/permission.js`);
const { HookRegistry } = await import(`${dist}/hooks/registry.js`);
const { SettingsManager } = await import(`${dist}/settings/manager.js`);
const { bindSource } = await import(`${dist}/sources/binding.js`);
const { readSourceDefinition } = await import(`${dist}/sources/catalog.js`);
const { createSourceCollectionService } = await import(`${workspace}/packages/desktop/src/main/source-collections-service.ts`);
const { Engine, LLMClientBase, registerProvider } = await import(`${dist}/index.js`);
const evidence: Record<string, unknown>[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

afterAll(() => {
  expect(attempts).toHaveLength(5);
  writeFileSync(new URL("./recovery-observations.json", import.meta.url), JSON.stringify({
    baseline: "a66f4ef291f304ee4df9da8095a90671d9a8f140", pid: process.pid, ppid: process.ppid,
    bun: process.versions.bun, node: process.versions.node, homeSha256: hash(realpathSync(process.env.HOME!)),
    executableSha256: hash(readFileSync(process.execPath)), negativeProbesBeforeCore: 5,
    compiled: Object.fromEntries(["tool-system/builtin/sources.js", "sources/adapters/collection.js", "sources/collection-local.js",
      "sources/collection-url.js", "tool-system/executor.js"].map(p => [p, hash(readFileSync(join(dist, p)))])),
    observations: evidence, unexpectedRequests: attempts.length - 5,
  }, null, 2));
  for (const [i, surface] of saved.entries()) {
    expect(Reflect.get(surface.object, surface.key)).toBe(owned[i]);
    if (surface.descriptor) Object.defineProperty(surface.object, surface.key, surface.descriptor);
    else Reflect.deleteProperty(surface.object, surface.key);
  }
  syncBuiltinESMExports();
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "round6-collection-recovery-")));
  const previous = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "state");
  const cwd = join(root, "project"); mkdirSync(cwd);
  const originals = join(root, "originals"); mkdirSync(originals);
  const paths = [join(originals, "alpha.txt"), join(originals, "beta.txt")];
  writeFileSync(paths[0], "budget common alpha"); writeFileSync(paths[1], "budget common beta");
  const api = createSourceCollectionService({ assertCurrent() {}, pick: async () => paths, references: async () => [] });
  let view = await api.create({ label: "Synthetic shared library" });
  view = (await api.pick(view.definition.id, view.revision, "files"))!;
  const source = view.definition.id;
  const ids = view.entries.map(({ entry }: any) => entry.id);
  bindSource(new SettingsManager(cwd, "project"), cwd, { sourceId: source, scopes: ids, readPolicy: "ask" });
  const query = { source, resources: ids.map(id => ({ scope: id, resource: id })), query: "budget", limit: 10 };
  const single = (i: number) => ({ source, scope: ids[i], resource: ids[i], query: "budget", limit: 10 });
  const approvals: unknown[] = [];
  let approval: (args: any) => boolean = () => true;
  function executor(rules = [{ tool: "ReadSource", decision: "allow" }], hooks = new HookRegistry()) {
    const permission = new PermissionClassifier(rules, "default", { requestApproval: async (req: any) => {
      approvals.push(req.args.resource ? { scope: req.args.scope, resource: req.args.resource } : "corpus");
      return { approved: approval(req.args) };
    }});
    const instance = new ToolExecutor(new ToolRegistry({ builtinTools: ["ListSources", "ReadSource"] }), permission, hooks);
    instance.setContext({ cwd, settingsScope: "project" });
    return { instance, permission };
  }
  const run = (instance: any, args = query) => instance.executeSingle({ id: randomUUID(), toolName: "ReadSource", args });
  return { root, paths, api, source, ids, view, query, single, executor, run, approvals,
    setApproval(fn: (args: any) => boolean) { approval = fn; },
    cleanup() { if (previous === undefined) delete process.env.CODE_SHELL_HOME; else process.env.CODE_SHELL_HOME = previous;
      rmSync(root, { recursive: true, force: true }); } };
}
function body(result: any) {
  expect(result.isError).toBe(false);
  return JSON.parse(String(result.result).split("\n<untrusted_input>\n")[1].split("\n</untrusted_input>")[0]);
}
function failure(result: any) { expect(result.isError).toBe(true); return String(result.error ?? result.result); }

test("changed original fails as a corpus; Desktop refresh retains entry ID and restores corpus", async () => {
  const f = await fixture();
  try {
    const executor = f.executor().instance;
    const before = body(await f.run(executor));
    expect(before.totalMatches).toBe(2);
    writeFileSync(f.paths[1], "budget updated beta document");
    const corpusError = failure(await f.run(executor));
    const singleError = failure(await f.run(executor, f.single(1) as any));
    expect(singleError).toContain("update the collection");
    const changed = await f.api.get(f.source);
    expect(changed.entries[1].status).toBe("changed");
    const refreshed = await f.api.update(f.source, changed.revision, { kind: "refresh", entryId: f.ids[1] });
    expect(refreshed.entries[1].entry.id).toBe(f.ids[1]);
    expect(refreshed.entries[1].status).toBe("ready");
    const after = body(await f.run(executor));
    expect(after.totalMatches).toBe(2);
    expect(after.resources.find((r: any) => r.resourceId === f.ids[1]).sourceHash).not.toBe(
      before.resources.find((r: any) => r.resourceId === f.ids[1]).sourceHash);
    evidence.push({ scenario: "changed-original-refresh-retry", corpusError, singleError,
      statusBeforeRefresh: changed.entries[1].status, statusAfterRefresh: refreshed.entries[1].status,
      stableEntryId: true, matchesBefore: before.totalMatches, matchesAfter: after.totalMatches });
  } finally { f.cleanup(); }
});

test("refusal returns no partial corpus; next request accepts each scope and succeeds", async () => {
  const f = await fixture();
  try {
    const sorted = [...f.ids].sort();
    f.setApproval(args => args.resource !== sorted[1]);
    const { instance } = f.executor([]);
    const refusal = await f.run(instance);
    const error = failure(refusal);
    expect(refusal.result).toBeUndefined();
    expect(f.approvals).toEqual(["corpus", ...sorted.map(id => ({ scope: id, resource: id }))]);
    f.setApproval(() => true);
    const retried = body(await f.run(instance));
    expect(retried.totalMatches).toBe(2);
    evidence.push({ scenario: "approval-refusal-retry", error, partialCorpusReturned: false,
      requests: f.approvals, retryMatches: retried.totalMatches });
  } finally { f.cleanup(); }
});

test("Engine exposes the parent corpus error to the conversation and the next deterministic fixture response", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.paths[1], "budget beta was edited in the normal editor");
    const observed: string[] = [];
    const streamed: any[] = [];
    // Deterministic in-process responses only: no API, remote provider, or paid model.
    class RecoveryFixtureClient extends LLMClientBase {
      sent = false;
      initClient() {}
      async createMessage(options: any) {
        if (!this.sent) {
          this.sent = true;
          return { text: "", toolCalls: [{ id: "round6-corpus", toolName: "ReadSource", args: f.query }], stopReason: "tool_use" };
        }
        for (const message of options.messages) {
          if (message.role === "tool") observed.push(String(message.content));
          else if (Array.isArray(message.content)) for (const block of message.content)
            if (block.type === "tool_result") observed.push(String(block.content));
        }
        return { text: "Fixture received the tool result", toolCalls: [], stopReason: "stop" };
      }
    }
    const provider = `round6-recovery-fixture-${randomUUID()}`;
    registerProvider(provider, RecoveryFixtureClient);
    const engine = new Engine({
      llm: { provider, model: "in-process-fixture", apiKey: "synthetic-fixture" },
      cwd: join(f.root, "project"), settingsScope: "project", sessionStorageDir: join(f.root, "sessions"),
      enabledBuiltinTools: ["ReadSource"], permissionMode: "default", headless: true, maxTurns: 3,
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
      behaviorProfiles: [{ id: "round6-recovery", disableSessionTitle: true, disableInstructions: true,
        disableMemoryContext: true, disableMcp: true, disableHooks: true }],
    });
    try {
      const outcome = await engine.run("Query the two explicitly selected synthetic documents", {
        sessionId: "round6-error-visibility", behaviorMode: "round6-recovery", toolAllowlist: ["ReadSource"],
        onStream: (event: any) => { if (event.type === "tool_result") streamed.push(event.result); },
      });
      expect(outcome.text).toBe("Fixture received the tool result");
      expect(streamed).toHaveLength(1);
      expect(streamed[0].id).toBe("round6-corpus");
      expect(streamed[0].error).toContain("denied, failed or produced no trusted receipt");
      expect(observed).toHaveLength(1);
      expect(observed[0]).not.toContain("update the collection before reading");
      expect(observed[0]).not.toContain(f.ids[1]);
      evidence.push({ scenario: "engine-conversation-error-visibility", streamResults: streamed,
        nextFixtureResponseToolResults: observed, specificChildReasonVisible: false, failingScopeVisible: false,
        deterministicInProcessClient: true });
    } finally { await engine.dispose(); }
  } finally { f.cleanup(); }
});

test("stale metadata update keeps newer catalog; reload and save recover", async () => {
  const f = await fixture();
  try {
    const newer = await f.api.update(f.source, f.view.revision, { kind: "metadata", label: "Other window", enabled: true });
    let conflict = "";
    try { await f.api.update(f.source, f.view.revision, { kind: "metadata", label: "Stale draft", enabled: true }); }
    catch (error) { conflict = String(error); }
    expect(conflict).toContain("其他窗口更新");
    expect(readSourceDefinition(f.source).label).toBe("Other window");
    const reload = await f.api.get(f.source);
    const saved = await f.api.update(f.source, reload.revision, { kind: "metadata", label: "Recovered draft", enabled: true });
    expect(saved.definition.label).toBe("Recovered draft");
    expect(saved.entries.map((e: any) => e.entry.id)).toEqual(f.ids);
    evidence.push({ scenario: "revision-conflict-reload-retry", conflict, newerRevisionRetained: reload.revision === newer.revision,
      savedLabel: saved.definition.label, selectedIdsPreserved: true });
  } finally { f.cleanup(); }
});
