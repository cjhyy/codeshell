import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCodexJsonLine } from "../../../packages/server/src/mobile-remote/codex-parse.ts";
globalThis.fetch = (() => { throw new Error("audit fixture forbids network"); }) as typeof fetch;
const { RoomManager } = await import("../../../packages/server/src/mobile-remote/room-manager.ts");

test("R3-01/02 parser projection loss persists through actual local RoomManager history", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-audit-room-projection-"));
  let manager: InstanceType<typeof RoomManager> | undefined;
  try {
    const cwd = join(dir, "workspace");
    mkdirSync(cwd);
    let clock = 1000;
    manager = new RoomManager({
      rootDir: join(dir, "rooms"), now: () => clock++, onMessage: () => {},
      createAgent: (_room, emit) => {
        let running = false;
        return {
          start() { running = true; }, stop() { running = false; }, isRunning() { return running; },
          send() {
            const lines = [
              { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" } },
              { type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "fixture", tool: "read", arguments: { path: "a.ts" }, status: "in_progress" } },
              { type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "fixture", tool: "read", result: { content: [{ type: "text", text: "readable local result" }], structured_content: null }, status: "completed" } },
              { type: "item.completed", item: { id: "m2", type: "mcp_tool_call", server: "fixture", tool: "read", error: { message: "local result unavailable" }, status: "failed" } },
              { type: "item.completed", item: { id: "t1", type: "agent_message", text: "completed local reply" } },
              { type: "turn.completed", usage: {} },
            ];
            for (const line of lines) for (const event of parseCodexJsonLine(JSON.stringify(line))) emit(event);
            return true;
          },
        };
      },
    });
    const room = manager.createRoom({ cwd, kind: "codex" });
    expect(manager.open(room.id).status).toBe("running");
    expect(manager.send(room.id, "local fixture question")).toBe(true);
    const messages = manager.getHistoryPage(room.id, { limit: 200 }).messages;
    console.log(JSON.stringify({ case: "persisted-codex-projection", messages }));
    expect(messages.some((m) => m.type === "tool" && m.tool === "Edit")).toBe(false);
    expect(messages.find((m) => m.type === "tool_result" && m.toolId === "m1")?.summary).toBe("[object Object]");
    expect(messages.find((m) => m.type === "tool_result" && m.toolId === "m2")?.summary).toBe("");
    expect(messages.some((m) => m.type === "text" && m.text === "completed local reply")).toBe(true);
    expect(messages.some((m) => m.type === "turn_end")).toBe(true);
  } finally {
    manager?.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
