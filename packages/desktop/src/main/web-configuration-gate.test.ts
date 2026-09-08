import { describe, expect, test } from "bun:test";
import { WebConfigurationGate } from "./web-configuration-gate.js";

describe("Desktop Web configuration admission", () => {
  test("queued runs for one session keep settings blocked until every request settles", async () => {
    const gate = new WebConfigurationGate();
    gate.beginRun("desktop-rpc-first", "shared-session");
    gate.beginRun("mobile-run-second", "shared-session");
    gate.observe(JSON.stringify({ id: "desktop-rpc-first", result: { reason: "completed" } }));
    expect(gate.isRunning("shared-session")).toBe(true);
    await expect(
      gate.mutate(
        async () => {},
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409 });
    gate.observe(JSON.stringify({ id: "mobile-run-second", error: { code: -32000 } }));
    expect(gate.isRunning("shared-session")).toBe(false);
    await expect(
      gate.mutate(
        async () => {},
        async () => {},
      ),
    ).resolves.toBeUndefined();
  });

  test("a submitted run blocks changes before its first streamed event and until its RPC settles", async () => {
    const gate = new WebConfigurationGate();
    gate.beginRun("r1", "session");
    expect(gate.isRunning("session")).toBe(true);
    let writes = 0;
    const write = async () => ++writes;
    await expect(gate.mutate(write, async () => {})).rejects.toMatchObject({ status: 409 });
    gate.observe(JSON.stringify({ method: "agent/runAccepted", params: { requestId: "r1" } }));
    gate.observe(
      JSON.stringify({ method: "agent/streamEvent", params: { event: { type: "turn_end" } } }),
    );
    expect(gate.isRunning("session")).toBe(true);
    gate.observe(JSON.stringify({ id: "r1", result: {} }));
    expect(gate.isRunning("session")).toBe(false);
    await expect(gate.mutate(write, async () => {})).resolves.toBe(1);
    expect(writes).toBe(1);
  });

  test("keeps admission closed throughout async persistence and reload", async () => {
    const gate = new WebConfigurationGate();
    let release!: () => void;
    const pending = gate.mutate(
      async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        expect(gate.runBlocked).toBe(true);
        return "saved";
      },
      async () => {
        expect(gate.runBlocked).toBe(true);
      },
    );
    expect(gate.runBlocked).toBe(true);
    await expect(
      gate.mutate(
        async () => {},
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409 });
    release();
    await expect(pending).resolves.toBe("saved");
    expect(gate.runBlocked).toBe(false);
  });

  test("failed reload requires a successful retry or worker replacement", async () => {
    const gate = new WebConfigurationGate();
    await expect(
      gate.mutate(
        async () => {},
        async () => {
          throw new Error("dead");
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(gate.runBlocked).toBe(true);
    await gate.mutate(
      async () => {},
      async () => {},
    );
    expect(gate.runBlocked).toBe(false);
    gate.beginRun("r1", "session");
    gate.workerExited();
    expect(gate.isRunning("session")).toBe(false);
    await expect(
      gate.mutate(
        async () => {},
        async () => {},
      ),
    ).resolves.toBeUndefined();
  });
});
