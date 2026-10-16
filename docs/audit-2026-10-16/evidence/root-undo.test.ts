import { test, expect, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
globalThis.fetch = (() => { throw new Error("audit denies network"); }) as typeof fetch;
const { FileHistory } = await import("../../../packages/core/src/session/file-history.ts");
const { earliestSnapshotsPerFile } = await import("../../../packages/core/src/session/undo-target.ts");
const { renderDiffPreview } = await import("../../../packages/core/src/session/simple-diff.ts");
const { AgentServer } = await import("../../../packages/core/src/protocol/server.ts");
const { AgentClient } = await import("../../../packages/core/src/protocol/client.ts");
const { ChatSessionManager } = await import("../../../packages/core/src/protocol/chat-session-manager.ts");
const { createInProcessTransport } = await import("../../../packages/core/src/protocol/transport.ts");
mock.module("@cjhyy/code-shell-core", () => ({ FileHistory, earliestSnapshotsPerFile, renderDiffPreview }));
const { utilityCommands } = await import("../../../packages/tui/src/cli/commands/builtin/utility-commands.ts");
const undo = utilityCommands.find((c) => c.name === "/undo")!;

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "cs-audit-undo-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("A08 protocol drops configured storage directory so /undo loads an empty default history", () => fixture(async (dir) => {
  const sessionId = "audit-custom-store";
  const storageDir = join(dir, "custom-store");
  const file = join(dir, "work.txt");
  writeFileSync(file, "before\n");
  const history = new FileHistory(join(storageDir, sessionId));
  expect(history.saveSnapshot(file, 1)).not.toBeNull();
  writeFileSync(file, "after\n");
  const manager = new ChatSessionManager({ runtime: {} as any, engineFactory: () => ({
    getConfig: () => ({ sessionStorageDir: storageDir, permissionMode: "default", llm: { provider: "openai", model: "audit" } }),
    getFeatureFlags: () => ({}), getPermissionRules: () => [],
    setAskUser() {}, setPlanMode() {}, setPermissionMode() {}, isHeadless: () => false,
    async dispose() {}, async close() {},
  }) as any });
  const [st, ct] = createInProcessTransport();
  const server = new AgentServer({ chatManager: manager, transport: st });
  const client = new AgentClient({ transport: ct });
  try {
    await manager.getOrCreate(sessionId, {} as any);
    const config = (await client.query("config", sessionId)).data as any;
    expect(config.sessionStorageDir).toBeUndefined();
    const statuses: string[] = [];
    await undo.execute("confirm", { client, sessionId, addStatus: (s: string) => statuses.push(s) } as any);
    expect(statuses.join("\n")).toContain("没有可撤销");
    expect(readFileSync(file, "utf8")).toBe("after\n");
    const plan = history.getLatestTurnUndoPlan()!;
    expect(history.undoLatestTurn(plan.snapshots)).toEqual([{ filePath: file, ok: true }]);
    expect(readFileSync(file, "utf8")).toBe("before\n");
  } finally { await server.close(); client.close(); }
}));

test("A09 /undo all ignores created-only turn while ordinary /undo correctly removes it", () => fixture(async (dir) => {
  const sessionId = "audit-created-only";
  const storageDir = join(dir, "sessions");
  const file = join(dir, "created.txt");
  const history = new FileHistory(join(storageDir, sessionId));
  history.recordCreated(file, 1);
  writeFileSync(file, "new file\n");
  const statuses: string[] = [];
  const ctx = { sessionId, client: { query: async () => ({ data: { sessionStorageDir: storageDir } }) }, addStatus: (s: string) => statuses.push(s) } as any;
  await undo.execute("all confirm", ctx);
  expect(statuses.join("\n")).toContain("没有可撤销");
  expect(existsSync(file)).toBe(true);
  await undo.execute("confirm", ctx);
  expect(existsSync(file)).toBe(false);
  expect(statuses.at(-1)).toContain("已撤销最近一轮的 1 个文件改动");
}));
