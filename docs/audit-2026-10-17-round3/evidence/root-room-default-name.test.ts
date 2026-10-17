import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
globalThis.fetch = (() => { throw new Error("audit fixture forbids network"); }) as typeof fetch;
const { RoomManager } = await import("../../../packages/server/src/mobile-remote/room-manager.ts");

function fixture(fn: (manager: InstanceType<typeof RoomManager>) => void) {
  const rootDir = mkdtempSync(join(tmpdir(), "cs-audit-room-name-"));
  const manager = new RoomManager({ rootDir, createAgent: () => { throw new Error("metadata-only fixture cannot start agents"); }, onMessage: () => {} });
  try { fn(manager); } finally { manager.closeAll(); rmSync(rootDir, { recursive: true, force: true }); }
}

test("R3-04 Windows default room name preserves the full path instead of its final component", () => fixture((manager) => {
  const cwd = String.raw`C:\work\project-name`;
  const room = manager.createRoom({ cwd });
  console.log(JSON.stringify({ case: "windows-default-name", cwd, name: room.name }));
  expect(room.name).toBe(cwd);
  expect(manager.getRoom(room.id)?.name).toBe(cwd);
}));

test("R3-04 accepted long Windows-form cwd writes metadata that the same reader rejects", () => fixture((manager) => {
  const cwd = "C:\\" + Array.from({ length: 12 }, () => "directory".repeat(5)).join("\\") + "\\project-name";
  const room = manager.createRoom({ cwd });
  console.log(JSON.stringify({ case: "long-windows-cwd", cwdLength: cwd.length, nameLength: room.name.length, returnedId: room.id, readable: !!manager.getRoom(room.id) }));
  expect(cwd.length).toBeGreaterThan(512);
  expect(room.name).toBe(cwd);
  expect(manager.getRoom(room.id)).toBeUndefined();
  expect(manager.listRooms().some((item) => item.id === room.id)).toBe(false);
  expect(() => manager.getHistoryPage(room.id)).toThrow("room is missing or its metadata is corrupt");
}));

test("POSIX basename and explicit Windows room name normal controls", () => fixture((manager) => {
  const posix = manager.createRoom({ cwd: "/work/project-name" });
  expect(posix.name).toBe("project-name");
  expect(manager.getRoom(posix.id)?.name).toBe("project-name");
  const explicit = manager.createRoom({ cwd: String.raw`C:\work\project-name`, name: "project-name" });
  expect(explicit.name).toBe("project-name");
  expect(manager.getRoom(explicit.id)?.name).toBe("project-name");
}));
