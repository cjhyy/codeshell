import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";

// The guarded shard supplies a real private HOME; no Core import precedes these probes.
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME)
  throw new Error("private test HOME required");
const originalFetch = globalThis.fetch;
const originals = [http.request, http.get, https.request, https.get];
const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
installLocalNetworkGuard("http://127.0.0.1:9");
expect(() => fetch("https://example.invalid/")).toThrow("non-fixture");
expect(() => http.get("http://127.0.0.1:8/")).toThrow("non-fixture");
const guardedFetch = globalThis.fetch;
afterAll(() => {
  if (globalThis.fetch !== guardedFetch) throw new Error("test guard ownership changed");
  globalThis.fetch = originalFetch;
  [http.request, http.get, https.request, https.get] = originals;
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else delete (globalThis as any)[marker];
  syncBuiltinESMExports();
});
const { MemoryManager } = await import("@cjhyy/code-shell-core");
const { saveWorkspaceProfile, readWorkspaceProfile, workspaceProfileDir } =
  await import("@cjhyy/code-shell-core/internal");
const { resolveRunProfileState } = await import("../../../core/src/engine/run-setup.js");
const { SettingsManager } = await import("../../../core/src/settings/manager.js");
const { PromptComposer } = await import("../../../core/src/prompt/composer.js");
const { ProfileMemoryPromotionReviews } = await import("./profile-memory-promotion-service.js");
const { registerProfileMemoryPromotionIpc } = await import("./profile-memory-promotion-ipc.js");
const { createProfileMemoryPromotionApi } =
  await import("../preload/profile-memory-promotion-api.js");

let root: string, cwd: string, previousHome: string | undefined;
let clock: number, reviews: InstanceType<typeof ProfileMemoryPromotionReviews>;
let source: InstanceType<typeof MemoryManager>;
let sourceId: string;
const draft = {
  name: "Reusable review",
  description: "Check the exit criteria",
  type: "reference" as const,
  content: "Confirm acceptance criteria before handoff.",
  pinned: true,
};
function profile(portableMemory = true) {
  return saveWorkspaceProfile({ name: "pm", label: "PM", basePreset: "general", portableMemory });
}
function input(scope: "user" | "dream" = "user") {
  return { cwd, source: { scope, id: sourceId }, profileName: "pm", draft: { ...draft } };
}
function target() {
  return new MemoryManager({ baseDir: workspaceProfileDir("pm"), scope: "user" });
}
function preview(scope: "user" | "dream" = "user") {
  return reviews.preview(1, input(scope));
}
function commit(reviewId: string) {
  return reviews.commit(1, { cwd, reviewId });
}
beforeEach(() => {
  root = mkdtempSync(join(process.env.HOME!, "profile-promotion-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "data");
  cwd = join(root, "project");
  mkdirSync(cwd);
  profile();
  source = new MemoryManager({ projectDir: cwd, scope: "user" });
  source.save({
    name: "Source",
    description: "Project only",
    type: "project",
    content: "Local details",
    origin: "auto",
    useCount: 19,
    updateCount: 4,
    lastUsedAt: "2020-01-01T00:00:00.000Z",
  });
  sourceId = source.loadAll()[0].id!;
  clock = 1000;
  reviews = new ProfileMemoryPromotionReviews(() => clock);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test("review is read-only; commit preserves source bytes and creates manual user memory with new identity", () => {
  const sourcePath = join(source.getMemoryDir(), source.loadAll()[0].fileName);
  const sourceBytes = readFileSync(sourcePath);
  const result = preview();
  expect(existsSync(join(workspaceProfileDir("pm"), "memory"))).toBe(false);
  result.draft.content = "renderer tamper";
  const created = commit(result.reviewId);
  const saved = target().findById(created.id)!;
  expect(readFileSync(sourcePath)).toEqual(sourceBytes);
  expect(saved.id).not.toBe(sourceId);
  expect(saved.content).toBe(draft.content);
  expect(saved.origin).toBe("manual");
  expect(saved.scope).toBe("user");
  expect(saved.useCount).toBe(0);
  expect(saved.updateCount).toBe(0);
  expect(saved.pinned).toBe(true);
  expect(MemoryManager.buildInjectionIndex({ profileDir: workspaceProfileDir("pm") })).toContain(
    draft.name,
  );
  expect(() => commit(result.reviewId)).toThrow("expired");
  expect(target().loadAll()).toHaveLength(1);
});
test("dream source becomes manual user memory without copying dream lifecycle", () => {
  source = new MemoryManager({ projectDir: cwd, scope: "dream" });
  source.save({
    name: "Dream",
    description: "Candidate",
    type: "reference",
    content: "Dream content",
    origin: "dream",
    useCount: 81,
    promotionStatus: "pending",
    originProjects: [cwd],
  });
  sourceId = source.loadAll()[0].id!;
  const created = commit(preview("dream").reviewId);
  const saved = target().findById(created.id)!;
  expect(source.findById(sourceId)?.origin).toBe("dream");
  expect(saved.origin).toBe("manual");
  expect(saved.useCount).toBe(0);
  expect(saved.promotionStatus).toBeUndefined();
  expect(saved.originProjects).toBeUndefined();
  expect(
    new MemoryManager({ baseDir: workspaceProfileDir("pm"), scope: "dream" }).loadAll(),
  ).toEqual([]);
});
test("disabled portable memory may be prepared without enabling the Profile", () => {
  profile(false);
  const review = preview();
  expect(review.target.portableMemory).toBe(false);
  commit(review.reviewId);
  expect(target().loadAll()).toHaveLength(1);
  expect(readWorkspaceProfile("pm")?.portableMemory).toBe(false);
});
test("source content change consumes review and never copies", () => {
  const review = preview();
  source.save({ ...source.findById(sourceId)!, content: "changed" });
  expect(() => commit(review.reviewId)).toThrow("source");
  expect(() => commit(review.reviewId)).toThrow("expired");
  expect(target().loadAll()).toEqual([]);
});
test("same content at a replaced source identity is rejected", () => {
  const review = preview();
  const path = join(source.getMemoryDir(), source.findById(sourceId)!.fileName);
  const bytes = readFileSync(path);
  renameSync(path, path + ".old");
  writeFileSync(path, bytes);
  expect(() => commit(review.reviewId)).toThrow("source");
});
test("deleted source is rejected", () => {
  const review = preview();
  source.delete(sourceId);
  expect(() => commit(review.reviewId)).toThrow("source");
});
test("any target Profile definition change rejects commit", () => {
  const review = preview();
  saveWorkspaceProfile({ ...readWorkspaceProfile("pm")!, mainInstruction: "New instructions" });
  expect(() => commit(review.reviewId)).toThrow("Profile");
  expect(target().loadAll()).toEqual([]);
});
test("existing and late same-name target memory are not overwritten", () => {
  const review = preview();
  target().save({ ...draft, content: "Keep this" });
  expect(() => commit(review.reviewId)).toThrow("name");
  expect(() => preview()).toThrow("name");
  expect(target().loadAll()[0].content).toBe("Keep this");
});
test("owner and cwd are bound, expired reviews and replaced reviews cannot commit", () => {
  const first = preview();
  expect(() => reviews.commit(2, { cwd, reviewId: first.reviewId })).toThrow("expired");
  const second = preview();
  expect(() => commit(first.reviewId)).toThrow("expired");
  expect(() => reviews.commit(1, { cwd: root, reviewId: second.reviewId })).toThrow("project");
  const third = preview();
  clock = third.expiresAt;
  expect(() => commit(third.reviewId)).toThrow("expired");
});
test("owner destruction discards review", () => {
  const review = preview();
  reviews.clearOwner(1);
  expect(() => commit(review.reviewId)).toThrow("expired");
});
test("payload cannot select global or pending scope, inject lifecycle or commit edited draft", () => {
  for (const patch of [
    { source: { scope: "pending", id: sourceId } },
    { profileName: "../pm" },
    { draft: { ...draft, origin: "dream" } },
    { draft: { ...draft, name: "bad\nname" } },
    { source: { scope: "user", id: sourceId }, level: "user" },
  ])
    expect(() => reviews.preview(1, { ...input(), ...patch })).toThrow();
  const review = preview();
  expect(() => reviews.commit(1, { cwd, reviewId: review.reviewId, draft })).toThrow();
  expect(() => preview("dream")).toThrow("source");
});
test("source or target symbolic links are rejected", () => {
  const path = join(source.getMemoryDir(), source.findById(sourceId)!.fileName);
  const outside = join(root, "other.md");
  renameSync(path, outside);
  symlinkSync(outside, path);
  expect(() => preview()).toThrow("memory");
  rmSync(path);
  renameSync(outside, path);
  mkdirSync(join(workspaceProfileDir("pm"), "memory"));
  symlinkSync(source.getMemoryDir(), join(workspaceProfileDir("pm"), "memory", "user"), "dir");
  expect(() => preview()).toThrow("memory");
});

function ipcHarness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const frame = {};
  let destroyed = false;
  const listeners: (() => void)[] = [];
  const sender = {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => destroyed,
    once: (_: string, fn: () => void) => listeners.push(fn),
  };
  const event = { sender, senderFrame: frame };
  let resolve: (value: unknown) => Promise<string> = async (value) => {
    if (value !== cwd) throw new Error("unauthorized project");
    return cwd;
  };
  registerProfileMemoryPromotionIpc(
    { handle: (name, fn) => handlers.set(name, fn) } as any,
    (value) => !destroyed && value === (sender as any),
    (value) => resolve(value),
  );
  return {
    call: (name: string, value: unknown, e = event) => handlers.get("memory:" + name)!(e, value),
    event,
    setResolve: (fn: typeof resolve) => {
      resolve = fn;
    },
    destroy: () => {
      destroyed = true;
      for (const fn of listeners) fn();
    },
  };
}
test("actual IPC reauthorizes cwd, binds main frame, and repeated clicks save once", async () => {
  const h = ipcHarness();
  await expect(
    h.call("previewProfilePromotion", input(), { ...h.event, senderFrame: {} }),
  ).rejects.toThrow("main window");
  const review = await h.call("previewProfilePromotion", input());
  const settled = await Promise.allSettled([
    h.call("commitProfilePromotion", { cwd, reviewId: review.reviewId }),
    h.call("commitProfilePromotion", { cwd, reviewId: review.reviewId }),
  ]);
  expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(target().loadAll()).toHaveLength(1);
});
test("IPC project revocation and destruction during authorization prevent writes", async () => {
  const h = ipcHarness();
  const review = await h.call("previewProfilePromotion", input());
  h.setResolve(async () => {
    throw new Error("revoked");
  });
  await expect(
    h.call("commitProfilePromotion", { cwd, reviewId: review.reviewId }),
  ).rejects.toThrow("revoked");
  const h2 = ipcHarness();
  h2.setResolve(async () => {
    h2.destroy();
    return cwd;
  });
  await expect(h2.call("previewProfilePromotion", input())).rejects.toThrow("main window");
  expect(target().loadAll()).toEqual([]);
});
test("preload sends only the reviewed token and cwd at commit", async () => {
  const calls: unknown[][] = [];
  const api = createProfileMemoryPromotionApi({
    invoke: async (...args: unknown[]) => {
      calls.push(args);
      return {};
    },
  } as any);
  await api.previewProfileMemoryPromotion(input());
  await api.commitProfileMemoryPromotion({ cwd, reviewId: "review" });
  expect(calls).toEqual([
    ["memory:previewProfilePromotion", input()],
    ["memory:commitProfilePromotion", { cwd, reviewId: "review" }],
  ]);
});

// Use the actual run setup and prompt consumer, with no Engine/model request.
test("run profile selection injects copied memory only when portableMemory is enabled", async () => {
  commit(preview().reviewId);
  const settings = new SettingsManager(cwd, "isolated");
  for (const enabled of [true, false]) {
    profile(enabled);
    const run = resolveRunProfileState({ sessionWorkspaceProfile: "pm", cwd, settings });
    const composer = new PromptComposer({
      cwd,
      model: "synthetic",
      profileMemoryDir: run.profileMemoryDir,
      disableInstructions: true,
      disableCapabilityContext: true,
      disableSourcesContext: true,
    });
    const message = await composer.buildDynamicContextMessage();
    const content = typeof message?.content === "string" ? message.content : "";
    expect(content.includes(draft.name)).toBe(enabled);
    expect(readWorkspaceProfile("pm")?.portableMemory).toBe(enabled);
  }
});
