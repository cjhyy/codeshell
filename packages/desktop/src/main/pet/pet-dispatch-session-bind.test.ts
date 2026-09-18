import { expect, test } from "bun:test";
import { PetDispatchService, type PetHostActionContext } from "./pet-dispatch-service.js";

test("Mimi binding uses adapter private-chat metadata through the host-action boundary", async () => {
  for (const privateFlag of [true, false, undefined]) {
    let context: PetHostActionContext | undefined;
    let declared: unknown;
    const service = new PetDispatchService({
      metadata: { ensure: async () => ({ petSessionId: "pet-one" }) },
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
      worker: {
        requestWorker: async (_method, params) => {
          declared = (params.profileParams as Record<string, unknown>).hostActions;
          return {
            ok: true,
            result: {
              text: "",
              reason: "completed",
              extensions: {
                pet: {
                  hostActions: [
                    {
                      kind: "sessionBind",
                      payload: { action: "enter", sessionSelector: "session-0123456789abcdef0123" },
                    },
                  ],
                },
              },
            },
          };
        },
      },
      hostCwd: "/tmp",
      hostActions: {
        sessionBind: async (_payload, trusted) => {
          context = trusted;
          return { action: "enter", ok: trusted?.isDirectMessage === true, message: "receipt" };
        },
      },
    });
    const result = await service.dispatch({
      type: "chat",
      message: "进入这个 Session",
      clientMessageId: `input-${privateFlag}`,
      source: {
        kind: "im-gateway",
        channel: "slack",
        target: "D-conversation",
        senderId: "U-owner",
        ...(privateFlag === undefined ? {} : { isDirectMessage: privateFlag }),
        capabilities: {
          inbound: { text: true, attachments: [] },
          outbound: { text: true, button: "link", attachments: [] },
        },
      },
    });
    expect(declared).toEqual(["sessionBind"]);
    expect(context).toMatchObject({
      senderId: "U-owner",
      isDirectMessage: privateFlag === true,
      completionTarget: { channel: "slack", target: "D-conversation" },
    });
    expect(result).toMatchObject({
      ok: true,
      hostActions: [{ kind: "sessionBind", ok: true, result: { ok: privateFlag === true } }],
    });
  }
});
