import { describe, expect, it } from "bun:test";
import { runAfterModelSwitch } from "./modelSwitchRun";

describe("runAfterModelSwitch", () => {
  it("waits for the session model switch before starting the run", async () => {
    const calls: string[] = [];
    let releaseConfigure!: () => void;

    const configureDone = new Promise<void>((resolve) => {
      releaseConfigure = resolve;
    });

    const runPromise = runAfterModelSwitch({
      sessionId: "s1",
      model: "openrouter",
      text: "hello",
      opts: { sessionId: "s1" },
      configure: async () => {
        calls.push("configure:start");
        await configureDone;
        calls.push("configure:end");
      },
      run: async () => {
        calls.push("run");
        return { ok: true };
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(["configure:start"]);

    releaseConfigure();
    const result = await runPromise;

    expect(calls).toEqual(["configure:start", "configure:end", "run"]);
    expect(result).toEqual({ ok: true });
  });

  it("starts the run immediately when no model is pinned", async () => {
    const calls: string[] = [];

    await runAfterModelSwitch({
      sessionId: "s1",
      model: null,
      text: "hello",
      opts: { sessionId: "s1" },
      configure: async () => {
        calls.push("configure");
      },
      run: async () => {
        calls.push("run");
        return { ok: true };
      },
    });

    expect(calls).toEqual(["run"]);
  });
});
