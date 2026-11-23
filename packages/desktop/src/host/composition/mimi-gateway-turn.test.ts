import { expect, test } from "bun:test";
import { runMimiGatewayTurn } from "./mimi-gateway-turn.js";
import type { MimiGatewayInput } from "../../shared/mimi-gateway-turn.js";
import type { PetDispatchCommand, PetDispatchResult } from "../../main/pet/pet-dispatch-service.js";
import type { PetHostActionReceiptRecordInput } from "../../main/pet/pet-host-action-completion.js";

const input: MimiGatewayInput = {
  message: " owner's request ",
  handoff: "trusted handoff",
  sessionId: "pet-local",
  attachments: [],
  origin: {
    channel: "fixture",
    target: "private",
    senderId: "owner",
    messageId: "7",
    isDirectMessage: true,
    capabilities: {
      inbound: { text: true, attachments: [] },
      outbound: { text: true, button: "link", attachments: [] },
    },
  },
};
function fixture(result: PetDispatchResult) {
  const commands: PetDispatchCommand[] = [],
    receipts: PetHostActionReceiptRecordInput[] = [],
    effects: string[] = [];
  const deps: Parameters<typeof runMimiGatewayTurn>[1] = {
    manager: {
      getSessionId: async () => "pet-local",
      dispatch: async (command) => {
        commands.push(command);
        return result;
      },
    },
    native: {
      submitted: async (e) => {
        effects.push("submitted:" + e.clientMessageId);
      },
      attachmentsSent: async () => {
        effects.push("sent");
      },
      dispatched: async () => {
        effects.push("dispatched");
      },
      completed: async (e) => {
        effects.push("receipt:" + e.message);
      },
    },
    render: async ({ baseText }) => ({ text: baseText + " (enriched)", attachments: [] }),
    receipt: {
      record: async (r) => {
        receipts.push(r);
        return { message: r.authoritativeMessage! };
      },
    },
    onReceiptError: (e) => {
      throw e;
    },
  };
  return { commands, receipts, effects, deps };
}
test("a gateway retry preserves the owner/destination-specific id and publishes the exact displayed receipt", async () => {
  const { commands, receipts, effects, deps } = fixture({
    ok: true,
    type: "chat",
    result: {},
    petSessionId: "pet-local",
    authoritativeReply: "Confirmed",
    contextCleared: true,
  });
  const retry = await runMimiGatewayTurn(input, deps);
  await runMimiGatewayTurn(input, deps);
  expect(retry.text).toBe("Confirmed (enriched)");
  expect(commands[0]).toMatchObject({
    type: "chat",
    message: "trusted handoff",
    source: { channel: "fixture", senderId: "owner", target: "private" },
  });
  expect(receipts[0]).toMatchObject({
    authoritativeMessage: retry.text,
    deliveryChannel: "fixture",
    userMessage: "owner's request",
    replaceAssistant: true,
  });
  expect(effects.slice(0, 4)).toEqual([effects[0]!, "dispatched", "sent", "receipt:" + retry.text]);
  expect(effects[0]).toBe(effects[4]);
  await runMimiGatewayTurn({ ...input, origin: { ...input.origin!, target: "second" } }, deps);
  expect(effects[8]).not.toBe(effects[0]);
});
test("foreign staged files are refused before notifying; a steered input consumes no reply or receipt", async () => {
  const { commands, receipts, effects, deps } = fixture({
    ok: true,
    type: "chat",
    result: {},
    petSessionId: "pet-local",
    suppressReply: true,
  });
  await expect(runMimiGatewayTurn({ ...input, sessionId: "pet-retired" }, deps)).rejects.toThrow(
    "Session changed",
  );
  await expect(
    runMimiGatewayTurn(
      {
        ...input,
        attachments: [{ sessionId: "foreign" } as MimiGatewayInput["attachments"][number]],
      },
      deps,
    ),
  ).rejects.toThrow("Session changed");
  expect(commands).toEqual([]);
  expect(effects).toEqual([]);
  expect(await runMimiGatewayTurn(input, deps)).toEqual({
    text: "",
    petSessionId: "pet-local",
    reason: "steered",
    suppressReply: true,
  });
  expect(receipts).toEqual([]);
});
