import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChatSessionManager, type EngineConfigSlice } from "./chat-session-manager.js";
import type { Engine } from "../engine/engine.js";
import type { EngineRuntime } from "../engine/runtime.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";

function makeManager() {
  return new ChatSessionManager({
    runtime: {} as unknown as EngineRuntime,
    engineFactory: (_slice: EngineConfigSlice) => ({}) as unknown as Engine,
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

  it("does not evict an expired idle session while it has a running background job", () => {
    const mgr = makeManager();
    const session = mgr.getOrCreate("s-bg-running", {} as EngineConfigSlice);
    backgroundJobRegistry.start("job-running", "s-bg-running", "DriveAgent running");
    session.lastActivityAt = Date.now() - 60_000;

    mgr.sweepIdle();

    expect(mgr.get("s-bg-running")).toBe(session);
  });

  it("still evicts an expired idle session with no running background jobs", () => {
    const mgr = makeManager();
    const session = mgr.getOrCreate("s-bg-none", {} as EngineConfigSlice);
    session.lastActivityAt = Date.now() - 60_000;

    mgr.sweepIdle();

    expect(mgr.get("s-bg-none")).toBeUndefined();
  });
});
