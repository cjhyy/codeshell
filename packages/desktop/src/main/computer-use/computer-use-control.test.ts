import { expect, test } from "bun:test";
import { createComputerUseControl } from "./computer-use-control";

test("global stop gates computer input without cancelling the owning Run", async () => {
  let notices = 0;
  const runs: unknown[] = [];
  const control = await createComputerUseControl({
    appPath: "/fixture",
    executablePath: process.execPath,
    log() {},
    notifyStopped() {
      notices++;
    },
  });
  try {
    control.bus.subscribe({
      onOperation() {},
      onRun(run) {
        runs.push(run);
      },
    });
    await control.bus.publish({
      id: "operation",
      sessionId: "running-session",
      action: "click",
      phase: "start",
      capture: false,
    });
    control.stopInput("test");
    control.stopInput("test");
    expect(control.gate.status().stopped).toBe(true);
    expect(control.gate.snapshot().cancelledSessions).toEqual([]);
    expect(runs).toEqual([]);
    expect(notices).toBe(1);
    control.resumeInput("test");
    expect(control.gate.status().stopped).toBe(false);
    // Run completion remains owned by the agent lifecycle, independently of input.
    control.bus.publishRun("running-session", "completed");
    expect(runs).toEqual([{ sessionId: "running-session", outcome: "completed" }]);
  } finally {
    await control.close();
  }
});
