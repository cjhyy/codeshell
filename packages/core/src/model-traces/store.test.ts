import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTraceStore } from "./store.js";
import type { ModelTraceRecord } from "./types.js";

function record(id: string, fields: Partial<ModelTraceRecord> = {}): ModelTraceRecord {
  return {
    version: 1,
    id,
    traceId: "run",
    source: "fixture",
    purpose: "main",
    provider: "openai",
    model: "model",
    startedAt: Date.now(),
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: { systemPrompt: "private prompt", messages: [], tools: [], parameters: {} },
    outputState: "recorded",
    output: { text: "private output" },
    attempts: [],
    ...fields,
  };
}
describe("ModelTraceStore", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "codeshell-trace-store-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  test("configuration is private, validated and hot across store instances", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    expect(store.getConfig()).toEqual({
      policyRevision: "defaults-v2",
      enabled: true,
      captureContent: true,
      includeEphemeral: true,
      retentionDays: 7,
    });
    const peer = new ModelTraceStore({ storageDir: directory });
    store.setConfig({ captureContent: true, includeEphemeral: true, retentionDays: 3 });
    expect(peer.getConfig().captureContent).toBe(true);
    peer.setConfig({ enabled: false });
    expect(store.getConfig().enabled).toBe(false);
    expect(() => store.setConfig({ retentionDays: 0 })).toThrow();
    expect(() => store.setConfig({ surprise: true } as any)).toThrow();
    if (process.platform !== "win32")
      expect(statSync(join(directory, "config.json")).mode & 0o777).toBe(0o600);
  });
  test("the v2 rollout enables old defaults once and preserves later explicit opt-outs", () => {
    const configFile = join(directory, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        policyRevision: "old-host-policy",
        enabled: false,
        captureContent: false,
        includeEphemeral: false,
        retentionDays: 14,
      }),
    );
    const store = new ModelTraceStore({ storageDir: directory });
    const peer = new ModelTraceStore({ storageDir: directory });
    const migrated = store.getConfig();
    expect(migrated).toMatchObject({
      enabled: false,
      captureContent: true,
      includeEphemeral: true,
      retentionDays: 14,
    });
    expect(migrated.policyRevision).not.toBe("old-host-policy");
    expect(peer.getConfig()).toEqual(migrated);
    // Reading does not create a race with another process writing preferences.
    expect(JSON.parse(readFileSync(configFile, "utf8")).defaultsVersion).toBeUndefined();
    const disabled = store.setConfig({ captureContent: false, includeEphemeral: false });
    expect(disabled.policyRevision).not.toBe(migrated.policyRevision);
    expect(JSON.parse(readFileSync(configFile, "utf8")).defaultsVersion).toBe(2);
    expect(peer.getConfig()).toEqual(disabled);
    peer.setConfig({ retentionDays: 21, enabled: true });
    expect(store.getConfig()).toMatchObject({
      enabled: true,
      captureContent: false,
      includeEphemeral: false,
      retentionDays: 21,
    });
    expect(() => store.setConfig({ defaultsVersion: 1 } as any)).toThrow();
  });
  test("saving an unrelated setting persists upgraded defaults without changing its generation", () => {
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({
        enabled: true,
        captureContent: false,
        includeEphemeral: false,
        retentionDays: 7,
      }),
    );
    const store = new ModelTraceStore({ storageDir: directory });
    const initial = store.getConfig();
    expect(store.setConfig({ retentionDays: 30 })).toEqual({ ...initial, retentionDays: 30 });
    expect(new ModelTraceStore({ storageDir: directory }).getConfig()).toEqual({
      ...initial,
      retentionDays: 30,
    });
  });
  test("pages stable IDs and searches metadata without returning bodies", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    for (let index = 0; index < 5; index++)
      store.write(
        record(`id-${index}`, {
          startedAt: Date.now() - index,
          workspacePath: index === 4 ? "/other" : "/workspace",
          sessionId: "s",
          model: index === 2 ? "second-model" : "model",
        }),
      );
    const first = store.list({ limit: 2, workspacePath: "/workspace" });
    expect(first.total).toBe(4);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).not.toHaveProperty("input");
    expect(first.items[0]).not.toHaveProperty("attempts");
    const second = store.list({ limit: 2, workspacePath: "/workspace", cursor: first.nextCursor });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    expect(store.list({ search: "SECOND-model fixture" }).items.map((item) => item.id)).toEqual([
      "id-2",
    ]);
    expect(store.list({ traceId: "missing" }).total).toBe(0);
    expect(store.get("id-2")?.input?.systemPrompt).toBe("private prompt");
    expect(() => store.list({ cursor: "bad cursor" })).toThrow();
  });
  test("Host workspace scopes union exact and prefix-limited sources before stable pagination", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    const startedAt = Date.now();
    for (const [id, workspacePath, source, offset] of [
      ["worktree-1", "/project/worktree", "desktop", 1],
      ["root-panel-1", "/project", "panel:video:tts", 2],
      ["worktree-2", "/project/worktree", "desktop", 3],
      ["root-panel-2", "/project", "panel:research:query", 4],
      ["root-chat", "/project", "desktop", 5],
      ["other-panel", "/other", "panel:video:tts", 6],
      ["unknown-panel", undefined, "panel:video:tts", 7],
    ] as const)
      store.write(record(id, { workspacePath, source, startedAt: startedAt - offset }));
    const workspaceScopes = [
      { workspacePath: "/project/worktree" },
      { workspacePath: "/project", sourcePrefix: "panel:" },
    ];
    const first = store.list({ workspaceScopes, limit: 2 });
    expect(first.total).toBe(4);
    expect(first.items.map((item) => item.id)).toEqual(["worktree-1", "root-panel-1"]);
    const second = store.list({ workspaceScopes, limit: 2, cursor: first.nextCursor });
    expect(second.total).toBe(4);
    expect(second.items.map((item) => item.id)).toEqual(["worktree-2", "root-panel-2"]);
    expect(second.nextCursor).toBeUndefined();
    expect(store.list({ workspacePath: "/project/worktree" }).total).toBe(2);
    expect(store.list({ workspaceScopes, source: "desktop" }).items.map((item) => item.id)).toEqual(
      ["worktree-1", "worktree-2"],
    );
  });
  test("Host-only workspace scopes are bounded, explicit and reject unknown authority fields", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    for (const workspaceScopes of [
      null,
      {},
      [],
      Array.from({ length: 9 }, () => ({ workspacePath: "/project" })),
      [null],
      [{ workspacePath: "" }],
      [{ workspacePath: "x\0y" }],
      [{ workspacePath: "/project", sourcePrefix: "" }],
      [{ workspacePath: "/project", sourcePrefix: 1 }],
      [{ workspacePath: "/project", sourcePrefix: "x\0y" }],
      [{ workspacePath: "/project", includeChildren: true }],
    ])
      expect(() => store.list({ workspaceScopes } as any)).toThrow("workspace scopes");
    expect(() =>
      store.list({ workspacePath: "/project", workspaceScopes: [{ workspacePath: "/other" }] }),
    ).toThrow("workspace scopes");
  });
  test("expired traces and events are unavailable and pruned", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    store.write(record("old", { startedAt: Date.now() - 3 * 86_400_000 }));
    store.writeEvent({
      id: "event",
      traceId: "run",
      kind: "tool",
      name: "Read",
      status: "completed",
      startedAt: Date.now() - 3 * 86_400_000,
      inputState: "not-recorded",
      outputState: "not-recorded",
    });
    store.setConfig({ retentionDays: 1 });
    expect(store.get("old")).toBeNull();
    expect(store.list().total).toBe(0);
    expect(store.events("run")).toEqual([]);
    expect(store.getEvent("run", "event")).toBeNull();
  });
  test("exact event lookup validates identity and rejects symlink directories", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    const value = {
      id: "exact-event",
      traceId: "exact-trace",
      kind: "tool" as const,
      name: "Read",
      startedAt: Date.now(),
      status: "running",
      inputState: "recorded" as const,
      input: "safe input",
      outputState: "not-recorded" as const,
    };
    store.writeEvent(value);
    expect(store.getEvent("exact-trace", "exact-event")).toEqual(value);
    expect(store.getEvent("other-trace", "exact-event")).toBeNull();
    expect(store.getEvent("exact-trace", "other-event")).toBeNull();
    expect(() => store.getEvent("exact-trace", "")).toThrow();
    const eventPath = join(directory, "events");
    const backup = join(directory, "event-backup");
    mkdirSync(backup);
    rmSync(eventPath, { recursive: true });
    symlinkSync(backup, eventPath);
    expect(store.getEvent("exact-trace", "exact-event")).toBeNull();
  });
  test("retention removes orphan bodies after a failed summary write", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    const summaryPath = join(directory, "summaries");
    writeFileSync(summaryPath, "summary directory is unavailable");
    expect(() =>
      store.write(record("orphan", { startedAt: Date.now() - 3 * 86_400_000 })),
    ).toThrow();
    expect(readdirSync(join(directory, "records"))).toHaveLength(1);
    rmSync(summaryPath);
    store.setConfig({ retentionDays: 1 });
    expect(readdirSync(join(directory, "records"))).toEqual([]);
    expect(store.get("orphan")).toBeNull();
  });
  test("rejects symlink directories and malformed record files", () => {
    const outside = join(directory, "outside"),
      storePath = join(directory, "store");
    mkdirSync(outside);
    mkdirSync(storePath);
    const file = createHash("sha256").update("secret").digest("hex") + ".json";
    writeFileSync(join(outside, file), JSON.stringify(record("secret")));
    symlinkSync(outside, join(storePath, "records"));
    symlinkSync(outside, join(storePath, "summaries"));
    symlinkSync(outside, join(storePath, "events"));
    const store = new ModelTraceStore({ storageDir: storePath });
    expect(store.get("secret")).toBeNull();
    expect(store.list().items).toEqual([]);
    expect(store.events("run")).toEqual([]);
    expect(() => store.write(record("new"))).toThrow();
    expect(readdirSync(outside)).toEqual([file]);
  });
  test("caps oversized bodies and retains attempt identity and coverage", () => {
    const store = new ModelTraceStore({ storageDir: directory });
    const value = record("large", {
      attempts: Array.from({ length: 20 }, (_, number) => ({
        id: `attempt-${number}`,
        number,
        startedAt: Date.now(),
        status: "completed",
        coverage: "provider-wire",
        inputState: "recorded",
        input: "x".repeat(250_000),
        outputState: "not-recorded",
      })),
    });
    store.write(value);
    const saved = store.get("large")!;
    expect(saved.attempts).toHaveLength(20);
    expect(saved.attempts.some((attempt) => attempt.inputState === "truncated")).toBe(true);
    expect(store.list().items[0].attemptCount).toBe(20);
    const raw = readFileSync(
      join(directory, "records", readdirSync(join(directory, "records"))[0]),
    );
    expect(raw.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

test("capture policy generations are Host-owned and change on every privacy transition", () => {
  const root = mkdtempSync(join(tmpdir(), "model-trace-policy-"));
  try {
    const store = new ModelTraceStore({ storageDir: root });
    const initial = store.getConfig().policyRevision;
    expect(store.setConfig({ retentionDays: 14 }).policyRevision).toBe(initial);
    store.setConfig({ captureContent: false });
    const enabled = store.setConfig({ captureContent: true }).policyRevision;
    expect(enabled).not.toBe(initial);
    expect(store.setConfig({ captureContent: true }).policyRevision).toBe(enabled);
    store.setConfig({ captureContent: false });
    const reopened = store.setConfig({ captureContent: true }).policyRevision;
    expect(reopened).not.toBe(enabled);
    expect(() => store.setConfig({ policyRevision: enabled } as any)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
