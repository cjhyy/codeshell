import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "../../../../server/src/mobile-remote/room-manager.js";
import type { ResidentAgentEvent } from "../../../../server/src/mobile-remote/resident-agent.js";
import { ApprovalBridge, type ApprovalDecision } from "./approval-bridge.js";

test.each(["Bash", "AskUserQuestion"])(
  "duplicate %s controls resolve the visible prompt with one terminal denial",
  async (toolName) => {
    const dir = mkdtempSync(join(tmpdir(), "approval-bridge-integration-"));
    const prompts: string[] = [];
    const resolutions: ApprovalDecision[] = [];
    const controls: { requestId: string; decision: unknown }[] = [];
    const settlements: Promise<boolean>[] = [];
    let emit!: (event: ResidentAgentEvent) => void;
    const bridge = new ApprovalBridge({
      onPush: (_room, request) => prompts.push(request.requestId),
      onResolve: (_room, _request, decision) => resolutions.push(decision),
    });
    const manager = new RoomManager({
      rootDir: dir,
      createAgent: (_room, onEvent) => {
        emit = onEvent;
        return {
          start() {},
          send: () => true,
          isRunning: () => true,
          stop() {},
          respondControl: (requestId, decision) => controls.push({ requestId, decision }),
        };
      },
      onMessage: () => {},
      // Match desktop main's real request -> decision -> resident-agent chain.
      onApprovalRequest: (room, event) => {
        settlements.push(
          bridge
            .request(room, event.requestId, event)
            .then((decision) => manager.respondApproval(room, event.requestId, decision)),
        );
      },
      onRoomEnded: (room) => bridge.cancelRoom(room),
    });
    try {
      const room = manager.createRoom({ cwd: "/repo" });
      manager.open(room.id);
      for (const text of ["original", "different input", "third conflicting input"]) {
        emit({
          type: "approval_request",
          requestId: "same-id",
          toolName,
          input:
            toolName === "AskUserQuestion"
              ? { questions: [{ question: text, options: [{ label: "yes" }] }] }
              : { command: text },
          description: text,
        });
      }
      expect(await Promise.all(settlements)).toEqual([true, false, false]);
      expect(prompts).toEqual(["same-id"]);
      const denial = { behavior: "deny", message: "duplicate approval request" };
      expect(resolutions).toEqual([denial]);
      expect(controls).toEqual([{ requestId: "same-id", decision: denial }]);
      expect(bridge.respond(room.id, "same-id", { behavior: "allow" })).toBe(false);
      expect(manager.respondApproval(room.id, "same-id", { behavior: "allow" })).toBe(false);
      expect(controls).toHaveLength(1);

      // The same wire ID in another room has an independent owner and decision.
      const otherRoom = manager.createRoom({ cwd: "/other-repo" });
      manager.open(otherRoom.id);
      emit({
        type: "approval_request",
        requestId: "same-id",
        toolName: "Bash",
        input: { command: "other room command" },
        description: "Independent request",
      });
      expect(prompts).toEqual(["same-id", "same-id"]);
      manager.close(room.id);
      expect(bridge.respond(otherRoom.id, "same-id", { behavior: "allow" })).toBe(true);
      expect(await settlements[3]).toBe(true);
      expect(controls[1]).toEqual({
        requestId: "same-id",
        decision: { behavior: "allow", updatedInput: { command: "other room command" } },
      });
    } finally {
      manager.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
