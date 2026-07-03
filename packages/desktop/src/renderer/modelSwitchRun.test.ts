import { describe, expect, it } from "bun:test";
import { runAfterModelSwitch } from "./modelSwitchRun";

describe("runAfterModelSwitch", () => {
  it("starts run synchronously with the model so a cold desktop worker can spawn", () => {
    const calls: string[] = [];

    void runAfterModelSwitch({
      sessionId: "s1",
      model: "openrouter",
      text: "hello",
      opts: { sessionId: "s1" },
      run: async (_text, opts) => {
        calls.push("run");
        expect(opts).toEqual({ sessionId: "s1", model: "openrouter" });
        return new Promise(() => {});
      },
    });

    expect(calls).toEqual(["run"]);
  });

  it("passes the pinned model on the run request", async () => {
    const calls: string[] = [];

    const result = await runAfterModelSwitch({
      sessionId: "s1",
      model: "openrouter",
      text: "hello",
      opts: { sessionId: "s1" },
      run: async (_text, opts) => {
        calls.push("run");
        expect(opts).toEqual({ sessionId: "s1", model: "openrouter" });
        return { ok: true };
      },
    });

    expect(calls).toEqual(["run"]);
    expect(result).toEqual({ ok: true });
  });

  it("starts the run immediately when no model is pinned", async () => {
    const calls: string[] = [];

    await runAfterModelSwitch({
      sessionId: "s1",
      model: null,
      text: "hello",
      opts: { sessionId: "s1" },
      run: async (_text, opts) => {
        calls.push("run");
        expect(opts).toEqual({ sessionId: "s1" });
        return { ok: true };
      },
    });

    expect(calls).toEqual(["run"]);
  });
});
