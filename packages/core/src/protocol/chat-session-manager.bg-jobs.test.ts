import { createFakeEngine } from "../testing/create-fake-engine.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";

import type { EngineRuntime } from "../engine/runtime.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";
import { MemoryClosureScheduler } from "../services/memory-closure.js";

function makeManager(runtime: Partial<EngineRuntime> = {}) {
  return new ChatSessionManager({
    runtime: runtime as unknown as EngineRuntime,
    engineFactory: (_slice: EngineConfigSlice) =>
      createFakeEngine({
        // Preserve the optional-capability fallbacks exercised by this fixture.
        dispose: undefined,
        getSessionManager: undefined,
        prepareSessionCloseFinalization: undefined,
      }),
    idleTtlMs: 10,
  });
}

describe("ChatSessionManager.sweepIdle background jobs", () => {
  beforeEach(() => {
    backgroundJobRegistry.reset();
  });

  afterEach(() => {
    backgroundJobRegistry.reset();
  });

  it("does not evict an expired idle session while it has a running background job", async () => {
    const mgr = makeManager();
    const session = await mgr.getOrCreate("s-bg-running", {} as EngineConfigSlice);
    backgroundJobRegistry.start("job-running", "s-bg-running", "DriveAgent running");
    session.lastActivityAt = Date.now() - 60_000;

    mgr.sweepIdle();

    expect(mgr.get("s-bg-running")).toBe(session);
  });

  it("still evicts an expired idle session with no running background jobs", async () => {
    const mgr = makeManager();
    const session = await mgr.getOrCreate("s-bg-none", {} as EngineConfigSlice);
    session.lastActivityAt = Date.now() - 60_000;

    mgr.sweepIdle();

    expect(mgr.get("s-bg-none")).toBeUndefined();
  });
});

describe("ChatSessionManager and memory closures", () => {
  it("does not evict an expired idle session while its memory closure is pending", async () => {
    const memoryClosures = new MemoryClosureScheduler({ idleMs: 60_000 });
    const mgr = makeManager({ memoryClosures });
    const session = await mgr.getOrCreate("s-closure-pending", {} as EngineConfigSlice);
    memoryClosures.schedule("s-closure-pending", async () => {});
    session.lastActivityAt = Date.now() - 60_000;

    mgr.sweepIdle();
    expect(mgr.get("s-closure-pending")).toBe(session);

    // Once nothing is pending the session is an ordinary idle one again.
    memoryClosures.cancel("s-closure-pending");
    mgr.sweepIdle();
    expect(mgr.get("s-closure-pending")).toBeUndefined();
    memoryClosures.dispose();
  });

  it("closing a session cancels its waiting memory closure", async () => {
    const memoryClosures = new MemoryClosureScheduler({ idleMs: 60_000 });
    const mgr = makeManager({ memoryClosures });
    await mgr.getOrCreate("s-closure-closed", {} as EngineConfigSlice);
    memoryClosures.schedule("s-closure-closed", async () => {});

    await mgr.close("s-closure-closed");

    expect(memoryClosures.hasPending("s-closure-closed")).toBe(false);
    memoryClosures.dispose();
  });
});
