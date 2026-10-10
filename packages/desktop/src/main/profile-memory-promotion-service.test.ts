import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
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
import { dirname, join } from "node:path";
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
test("legacy frontmatter without an id copies to a new manual UUID and preserves its source", () => {
  const path = join(source.getMemoryDir(), "legacy.md");
  const bytes = Buffer.from(
    "---\nname: Legacy\ndescription: Old entry\ntype: reference\n---\n\nLegacy body\n",
  );
  writeFileSync(path, bytes);
  sourceId = "legacy:user:legacy.md";
  const review = preview();
  expect(review.source.id).toBe(sourceId);
  expect(review.source.content).toBe("Legacy body");
  const created = commit(review.reviewId);
  expect(created.id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  expect(target().findById(created.id)?.origin).toBe("manual");
  expect(readFileSync(path)).toEqual(bytes);
});
test("flat legacy memory preview refuses migration and leaves files in place", () => {
  const path = join(dirname(source.getMemoryDir()), "flat-legacy.md");
  const bytes = Buffer.from("---\nname: Flat\ndescription: Old layout\n---\n\nKeep in place\n");
  writeFileSync(path, bytes);
  expect(() => preview()).toThrow("legacy memory layout");
  expect(readFileSync(path)).toEqual(bytes);
  expect(existsSync(join(source.getMemoryDir(), "flat-legacy.md"))).toBe(false);
  expect(existsSync(join(workspaceProfileDir("pm"), "memory"))).toBe(false);
});
test("disabled portable memory may be prepared without enabling the Profile", () => {
  profile(false);
  const review = preview();
  expect(review.target.portableMemory).toBe(false);
  commit(review.reviewId);
  expect(target().loadAll()).toHaveLength(1);
  expect(readWorkspaceProfile("pm")?.portableMemory).toBe(false);
});
test("existing empty description and body can be copied without enabling portable memory", () => {
  profile(false);
  source.save({ ...source.findById(sourceId)!, description: "", content: "" });
  const review = reviews.preview(1, {
    ...input(),
    draft: { ...draft, description: "", content: "" },
  });
  expect(review.source.description).toBe("");
  expect(review.source.content).toBe("");
  const saved = target().findById(commit(review.reviewId).id)!;
  expect(saved.description).toBe("");
  expect(saved.content).toBe("");
  expect(readWorkspaceProfile("pm")?.portableMemory).toBe(false);
  for (const patch of [{ name: " " }, { description: "bad\0value" }, { content: "bad\0value" }])
    expect(() => reviews.preview(1, { ...input(), draft: { ...draft, ...patch } })).toThrow();
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

test("review directory enumeration stops at its entry limit", () => {
  for (let index = 0; index < 2048; index++)
    writeFileSync(join(source.getMemoryDir(), `extra-${index}.tmp`), "");
  expect(() => preview()).toThrow("entry limit");
  expect(existsSync(join(workspaceProfileDir("pm"), "memory"))).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "regular file replaced by a real FIFO at open is rejected without blocking Main",
  async () => {
    const path = join(source.getMemoryDir(), source.findById(sourceId)!.fileName);
    // The child interposes only the final open to reproduce the lstat/open race.
    // It delegates exactly once to the real filesystem with production flags.
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { spawnSync } from "node:child_process";
      import { mock } from "bun:test";
      const { installLocalNetworkGuard } = await import(${JSON.stringify(new URL("../../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url).href)});
      installLocalNetworkGuard("http://127.0.0.1:9");
      assert.throws(() => fetch("https://memory-promotion.invalid/"), /non-fixture/);
      const originalOpen = fs.openSync;
      let replaced = 0, flags;
      mock.module("node:fs", () => ({ ...fs, default: fs, openSync(path, options, ...rest) {
        if (path === ${JSON.stringify(path)}) {
          assert.equal(++replaced, 1);
          flags = options;
          fs.unlinkSync(path);
          const fifo = spawnSync("/usr/bin/mkfifo", [path]);
          assert.equal(fifo.status, 0, String(fifo.stderr));
        }
        return originalOpen(path, options, ...rest);
      } }));
      const { ProfileMemoryPromotionReviews } = await import(${JSON.stringify(new URL("./profile-memory-promotion-service.ts", import.meta.url).href)});
      assert.throws(() => new ProfileMemoryPromotionReviews().preview(1, ${JSON.stringify(input())}), /memory file/);
      assert.equal(replaced, 1);
      assert.ok(flags & fs.constants.O_NONBLOCK);
      assert.equal(fs.existsSync(${JSON.stringify(join(workspaceProfileDir("pm"), "memory"))}), false);
      console.log(JSON.stringify({ pid:process.pid, ppid:process.ppid, replaced, nonblocking:true, noWrite:true }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ replaced: 1, nonblocking: true, noWrite: true });
  },
);

function ipcHarness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  let frameDestroyed = false;
  const frame = { processId: 11, routingId: 12, isDestroyed: () => frameDestroyed };
  let destroyed = false;
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => destroyed,
  });
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
    navigate: (mainFrame = true) => {
      sender.emit("did-start-navigation", {}, "file:///fixture.html", false, mainFrame);
    },
    processGone: () => sender.emit("render-process-gone", {}, { reason: "crashed" }),
    changeFrameIdentity: () => {
      frame.processId++;
      frame.routingId++;
    },
    destroyFrame: () => {
      frameDestroyed = true;
    },
    setResolve: (fn: typeof resolve) => {
      resolve = fn;
    },
    destroy: () => {
      destroyed = true;
      sender.emit("destroyed");
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
test.each(["navigate", "processGone", "changeFrameIdentity", "destroyFrame"] as const)(
  "IPC %s invalidates a completed review even when the frame object is reused",
  async (change) => {
    const h = ipcHarness();
    const review = await h.call("previewProfilePromotion", input());
    h[change]();
    await expect(
      h.call("commitProfilePromotion", { cwd, reviewId: review.reviewId }),
    ).rejects.toThrow();
    expect(target().loadAll()).toEqual([]);
  },
);
test.each(["preview", "commit"] as const)(
  "main-frame navigation during %s authorization cannot revive an old review",
  async (stage) => {
    const h = ipcHarness();
    const review = stage === "commit" ? await h.call("previewProfilePromotion", input()) : null;
    let complete!: (cwd: string) => void;
    h.setResolve(() => new Promise<string>((resolve) => (complete = resolve)));
    const pending = h.call(
      stage === "preview" ? "previewProfilePromotion" : "commitProfilePromotion",
      review ? { cwd, reviewId: review.reviewId } : input(),
    );
    // Electron may retain the same WebFrameMain wrapper and even its numeric
    // identity. The navigation lifetime itself must invalidate this await.
    h.navigate();
    complete(cwd);
    await expect(pending).rejects.toThrow("window changed");
    expect(target().loadAll()).toEqual([]);
  },
);
test("iframe navigation preserves the main-frame review", async () => {
  const h = ipcHarness();
  const review = await h.call("previewProfilePromotion", input());
  h.navigate(false);
  await h.call("commitProfilePromotion", { cwd, reviewId: review.reviewId });
  expect(target().loadAll()).toHaveLength(1);
});
test("superseded authorization cannot erase a newer valid review", async () => {
  const h = ipcHarness();
  const first = await h.call("previewProfilePromotion", input());
  let complete!: (cwd: string) => void;
  h.setResolve(() => new Promise<string>((resolve) => (complete = resolve)));
  const pending = h.call("commitProfilePromotion", { cwd, reviewId: first.reviewId });
  h.setResolve(async () => cwd);
  const next = await h.call("previewProfilePromotion", input());
  complete(cwd);
  await expect(pending).rejects.toThrow("expired");
  await h.call("commitProfilePromotion", { cwd, reviewId: next.reviewId });
  expect(target().loadAll()).toHaveLength(1);
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
