import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

let networkAttempts = 0;
const denied = () => { networkAttempts++; throw new Error("audit fixture has no network"); };
globalThis.fetch = denied as typeof fetch;
for (const mod of [http, https]) {
  (mod as any).request = denied;
  (mod as any).get = denied;
}
net.Socket.prototype.connect = denied as any;

// Imports occur after the offline guard. No Engine/provider is constructed.
const { CommandRegistry } = await import("../../../packages/tui/src/cli/commands/registry.ts");
const { imageCommand } = await import("../../../packages/tui/src/cli/commands/builtin/image-command.ts");
const { coreCommands } = await import("../../../packages/tui/src/cli/commands/builtin/core-commands.ts");
const { extraCommands } = await import("../../../packages/tui/src/cli/commands/builtin/extra-commands.ts");
const { logger, getLogsDir } = await import("../../../packages/core/src/logging/logger.ts");
const { SettingsManager } = await import("../../../packages/core/src/settings/manager.ts");
const { AgentServer } = await import("../../../packages/core/src/protocol/server.ts");
const { AgentClient } = await import("../../../packages/core/src/protocol/client.ts");
const { ChatSessionManager } = await import("../../../packages/core/src/protocol/chat-session-manager.ts");
const { createInProcessTransport } = await import("../../../packages/core/src/protocol/transport.ts");

test("CLI-R4-01 actual registry changes a quoted two-space image filename", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "audit-r4-cli-image-"));
  const queue: string[] = [];
  const statuses: string[] = [];
  const ctx = {
    cwd, addStatus: (s: string) => statuses.push(s),
    pendingImages: { add: (s: string) => queue.push(s), list: () => queue, clear: () => { queue.length = 0; } },
  } as any;
  // Valid 1x1 PNG; the command only reads the bytes and stages a wire block.
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF2kAAAAASUVORK5CYII=", "base64");
  writeFileSync(join(cwd, "a  b.png"), bytes);
  try {
    await imageCommand.execute('"a  b.png"', ctx);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toContain('name="a  b.png"');
    queue.length = 0;
    statuses.length = 0;
    const registry = new CommandRegistry();
    registry.register(imageCommand);
    await registry.dispatch('/image "a  b.png"', ctx);
    expect(queue).toHaveLength(0);
    expect(statuses.join("\n")).toContain(join(cwd, "a b.png"));
    expect(statuses.join("\n")).toContain("读取失败");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("CLI-R4-02 actual logger creates bucket files that /log never reads", async () => {
  const marker = "audit-r4-real-log-marker";
  logger.child({ cat: "engine" }).info(marker);
  logger.child({ cat: "ui" }).info(marker + "-ui");
  const date = new Date().toISOString().slice(0, 10);
  const dir = getLogsDir();
  expect(dir).toBe(join(homedir(), ".code-shell", "logs"));
  expect(readFileSync(join(dir, `engine-${date}.log`), "utf8")).toContain(marker);
  expect(readFileSync(join(dir, `ui-ink-${date}.log`), "utf8")).toContain(marker + "-ui");
  expect(readdirSync(dir)).not.toContain(`${date}.log`);
  const statuses: string[] = [];
  await extraCommands.find((c) => c.name === "/log")!.execute("20", { addStatus: (s: string) => statuses.push(s) } as any);
  expect(statuses).toEqual([`No logs found for today (${date}).`]);
});

test("CLI-R4-03 /compact selects the detached engine while explicit session query selects owner", async () => {
  const calls: Array<{ owner: string; sessionId?: string }> = [];
  const manager = new ChatSessionManager({
    runtime: {} as any,
    engineFactory: () => ({
      owner: "detached",
      setAskUser() {}, setPlanMode() {}, isHeadless: () => false,
      async forceCompact(this: any, sessionId?: string) {
        calls.push({ owner: this.owner, sessionId });
        return this.owner === "live" ? { before: 100, after: 20, strategy: "compacted" } : { before: 0, after: 0, strategy: "none (no active session)" };
      },
      async dispose() {}, async close() {},
    }) as any,
  });
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ chatManager: manager, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });
  try {
    const live = await manager.getOrCreate("audit-r4-live", {} as any);
    (live.engine as any).owner = "live";
    const statuses: string[] = [];
    await coreCommands.find((c) => c.name === "/compact")!.execute("", {
      client, sessionId: "audit-r4-live", addStatus: (s: string) => statuses.push(s),
    } as any);
    expect(calls).toEqual([{ owner: "detached", sessionId: undefined }]);
    expect(statuses.at(-1)).toBe("Context is already compact (0 tokens). No compaction needed.");
    const control = await client.query("compact", "audit-r4-live");
    expect(control.data).toMatchObject({ before: 100, after: 20 });
    expect(calls.at(-1)).toEqual({ owner: "live", sessionId: "audit-r4-live" });
  } finally { await server.close(); client.close(); }
});

test("CLI-R4-04 /config get ignores user setting that REPL full scope loads", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "audit-r4-cli-config-"));
  const userFile = join(homedir(), ".code-shell", "settings.json");
  const before = readFileSync(userFile);
  const statuses: string[] = [];
  try {
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    writeFileSync(userFile, JSON.stringify({ context: { maxTokens: 24680 } }));
    expect(new SettingsManager(cwd, "full").get().context.maxTokens).toBe(24680);
    const projectValue = new SettingsManager(cwd).get().context.maxTokens;
    expect(projectValue).not.toBe(24680);
    await coreCommands.find((c) => c.name === "/config")!.execute("get context.maxTokens", {
      cwd, addStatus: (s: string) => statuses.push(s),
    } as any);
    expect(statuses).toEqual([`context.maxTokens = ${projectValue}`]);
  } finally {
    writeFileSync(userFile, before);
    rmSync(cwd, { recursive: true, force: true });
  }
  expect(networkAttempts).toBe(0);
});
