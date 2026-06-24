import { describe, it, expect } from "bun:test";
import { scheduleRoomTaskToolDef } from "./schedule-room-task.js";

describe("ScheduleRoomTask tool", () => {
  it("declares schedule/kind/prompt schema", () => {
    expect(scheduleRoomTaskToolDef.name).toBe("ScheduleRoomTask");
    const p = (scheduleRoomTaskToolDef.inputSchema as any).properties;
    expect(p.schedule).toBeDefined();
    expect(p.kind).toBeDefined();
    expect(p.continuation).toBeDefined();
  });
});
