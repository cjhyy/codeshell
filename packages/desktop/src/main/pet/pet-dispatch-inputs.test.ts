import { describe, expect, test } from "bun:test";
import { PetDispatchService, type PetDispatchCommand } from "./pet-dispatch-service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("Mimi accepted chat input snapshot", () => {
  test.each(["completed", "aborted_streaming", "error"])(
    "retains the queued intent through %s and clears only settled inputs",
    async (reason) => {
      const first = deferred<any>();
      const second = deferred<any>();
      const firstStarted = deferred<void>();
      const secondStarted = deferred<void>();
      const steered = deferred<void>();
      const calls: Array<{ method: string; clientMessageId?: string }> = [];
      const service = new PetDispatchService({
        metadata: { ensure: async () => ({ petSessionId: "pet-inputs" }) },
        aggregator: {
          getSnapshot: () => ({
            version: 1,
            generation: 1,
            workerState: "active",
            observedAt: 1,
            sessions: [],
            pending: [],
          }),
          resolveNavigation: async () => ({ status: "not-found" }),
        },
        hostCwd: "/work",
        worker: {
          requestWorker: async (method, params) => {
            calls.push({ method, clientMessageId: params.clientMessageId });
            if (method === "agent/steer") {
              steered.resolve();
              return { ok: true, result: { accepted: true } };
            }
            if (method === "agent/unsteer") return { ok: true, result: { removed: true } };
            if (method !== "agent/run") throw new Error(`unexpected method ${method}`);
            if (params.clientMessageId === "first") {
              firstStarted.resolve();
              return first.promise;
            }
            secondStarted.resolve();
            return second.promise;
          },
        },
      });
      const inputs = async () => {
        const result = await service.dispatch({ type: "get_global_status" });
        if (!result.ok || result.type !== "global_status") throw new Error("missing status");
        return result.chatInputs;
      };
      const command: PetDispatchCommand = {
        type: "chat",
        message: "same text",
        clientMessageId: "first",
      };
      const firstResult = service.dispatch(command);
      await firstStarted.promise;
      const duplicate = service.dispatch(command);
      const attachment = {
        kind: "image" as const,
        path: "picture.png",
        absPath: "/work/picture.png",
        sessionId: "pet-inputs",
        mime: "image/png",
        originalName: "picture.png",
      };
      const next = service.dispatch({
        type: "chat",
        message: "same text",
        clientMessageId: "second",
        attachments: [
          {
            ...attachment,
            id: "attachment",
            origin: "im-gateway",
            size: 4,
            sha256: "hash",
            createdAt: 1,
            sourcePath: "/private/source",
          },
        ],
      });
      await steered.promise;
      expect(await inputs()).toEqual([
        {
          clientMessageId: "first",
          message: "same text",
          pending: false,
          createdAt: expect.any(Number),
        },
        {
          clientMessageId: "second",
          message: "same text",
          pending: true,
          createdAt: expect.any(Number),
          attachments: [attachment],
        },
      ]);
      first.resolve(
        reason === "error"
          ? { ok: false, message: "worker exited" }
          : { ok: true, result: { text: "first reply", reason } },
      );
      await secondStarted.promise;
      expect(await duplicate).toEqual(await firstResult);
      expect(await inputs()).toEqual([
        {
          clientMessageId: "second",
          message: "same text",
          pending: false,
          createdAt: expect.any(Number),
          attachments: [attachment],
        },
      ]);
      second.resolve({ ok: true, result: { text: "second reply", reason: "completed" } });
      await next;
      expect(await inputs()).toEqual([]);
      expect(
        calls.filter((call) => call.method === "agent/run").map((call) => call.clientMessageId),
      ).toEqual(["first", "second"]);
    },
  );

  test("a rejected command leaves no accepted input to restore", async () => {
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-inputs" }) },
      aggregator: {
        getSnapshot: () => ({
          version: 1,
          generation: 1,
          workerState: "active",
          observedAt: 1,
          sessions: [],
          pending: [],
        }),
        resolveNavigation: async () => ({ status: "not-found" }),
      },
      hostCwd: "/work",
      worker: { requestWorker: async () => ({ ok: false, message: "model unavailable" }) },
    });
    await service.dispatch({ type: "chat", message: "request", clientMessageId: "rejected" });
    const result = await service.dispatch({ type: "get_global_status" });
    expect(result).toMatchObject({ chatInputs: [] });
  });
});
