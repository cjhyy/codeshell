import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "../../../../packages/server/src/mobile-remote/room-manager.ts";
import { ResidentAgentProcess } from "../../../../packages/server/src/mobile-remote/resident-agent.ts";

test("review reproduction: Claude room is left running after spawn failure and cannot retry opening", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-review-room-spawn-"));
  const command = join(root, "fixture-agent");
  let created = 0;
  let reportError!: () => void;
  const errorSeen = new Promise<void>((resolve) => (reportError = resolve));
  const manager = new RoomManager({
    rootDir: join(root, "rooms"),
    createAgent: (room, onEvent) => {
      created++;
      return new ResidentAgentProcess({
        command,
        cwd: room.cwd,
        permissionMode: "default",
        onEvent,
      });
    },
    onMessage: (_id, message) => {
      if (message.type === "error") reportError();
    },
  });
  try {
    const room = manager.createRoom({ cwd: root });
    expect(manager.open(room.id).status).toBe("running");
    await Promise.race([
      errorSeen,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(Error("missing spawn failure")), 2000),
      ),
    ]);
    expect(manager.getMessages(room.id).some((m) => m.type === "error")).toBe(true);
    // Simulate fixing/installing the missing CLI in exactly the command path.
    writeFileSync(command, "#!/bin/sh\ncat >/dev/null\n");
    chmodSync(command, 0o700);
    expect(manager.isOpen(room.id)).toBe(true);
    expect(manager.open(room.id).status).toBe("running");
    expect(created).toBe(1);
    expect(manager.send(room.id, "retry after installation")).toBe(false);
    console.info(
      "Confirmed: failed process remains registered as running; reopening does not respawn after CLI is installed.",
    );
  } finally {
    manager.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
});
