import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentClient,
  AgentServer,
  ChatSessionManager,
  FileHistory,
  createInProcessTransport,
} from "@cjhyy/code-shell-core";
import type { CommandContext } from "../registry.js";
import { utilityCommands } from "./utility-commands.js";

const undo = utilityCommands.find((command) => command.name === "/undo")!;

describe("/undo", () => {
  let root: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-undo-command-"));
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  // Real protocol path; the session engine only reports its configured storage root.
  async function connect(sessionId: string, sessionStorageDir: string) {
    const manager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        ({
          getConfig: () => ({
            sessionStorageDir,
            permissionMode: "default",
            llm: { provider: "openai", model: "fixture" },
          }),
          getFeatureFlags: () => ({}),
          getPermissionRules: () => [],
          setAskUser() {},
          setPlanMode() {},
          setPermissionMode() {},
          isHeadless: () => false,
          async dispose() {},
          async close() {},
        }) as never,
    });
    const [serverTransport, clientTransport] = createInProcessTransport();
    const server = new AgentServer({ chatManager: manager, transport: serverTransport });
    const client = new AgentClient({ transport: clientTransport });
    cleanups.push(() => client.close());
    cleanups.push(() => server.close());
    await manager.getOrCreate(sessionId, {} as never);
    const statuses: string[] = [];
    const messages: string[] = [];
    const ctx = {
      client,
      sessionId,
      addStatus: (text: string) => statuses.push(text),
      addMessage: (text: string) => messages.push(text),
    } as unknown as CommandContext;
    return { ctx, statuses, messages };
  }

  test("reads file history from the session's configured storage directory", async () => {
    const storageDir = join(root, "custom-sessions");
    const file = join(root, "work.txt");
    writeFileSync(file, "before\n");
    const history = new FileHistory(join(storageDir, "custom"));
    history.saveSnapshot(file, 1);
    writeFileSync(file, "after\n");
    const { ctx, statuses } = await connect("custom", storageDir);

    await undo.execute("confirm", ctx);

    expect(readFileSync(file, "utf-8")).toBe("before\n");
    expect(statuses.join("\n")).toContain("已撤销最近一轮的 1 个文件改动");
  });

  test("all previews and removes files the session created", async () => {
    const storageDir = join(root, "sessions");
    const edited = join(root, "edited.txt");
    const created = join(root, "created.txt");
    writeFileSync(edited, "edited-before\n");
    const history = new FileHistory(join(storageDir, "whole"));
    history.saveSnapshot(edited, 1);
    writeFileSync(edited, "edited-after\n");
    history.recordCreated(created, 2);
    writeFileSync(created, "new file\n");
    const { ctx, statuses, messages } = await connect("whole", storageDir);

    await undo.execute("all", ctx);
    expect(messages.at(-1)).toContain("2 个文件");
    expect(messages.at(-1)).toContain(created);

    await undo.execute("all confirm", ctx);
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(edited, "utf-8")).toBe("edited-before\n");
    expect(statuses.at(-1)).toContain("已撤销全部 2 个文件");
  });
});
