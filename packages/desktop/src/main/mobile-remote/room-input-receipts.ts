import type { RoomManager } from "@cjhyy/code-shell-server/mobile-remote";

type Receipt = Parameters<RoomManager["hasAcceptedInput"]>[1];
const pending = new WeakMap<RoomManager, Map<string, { hash: string; result: Promise<boolean> }>>();

/** Coalesce retries before attachment staging, with durable Room history as the restart boundary. */
export async function submitRoomInputOnce(
  rooms: RoomManager,
  roomId: string,
  receipt: Receipt,
  submit: () => Promise<boolean>,
): Promise<boolean> {
  let inputs = pending.get(rooms);
  if (!inputs) pending.set(rooms, (inputs = new Map()));
  const key = JSON.stringify([roomId, receipt.clientDeviceId, receipt.clientMessageId]);
  const existing = inputs.get(key);
  if (existing) {
    if (existing.hash !== receipt.clientIntentHash)
      throw new Error("同一输入的内容已改变，请核对草稿后作为新消息发送。");
    return existing.result;
  }
  if (rooms.hasAcceptedInput(roomId, receipt)) return true;
  const entry = { hash: receipt.clientIntentHash, result: Promise.resolve().then(submit) };
  inputs.set(key, entry);
  try {
    return await entry.result;
  } finally {
    if (inputs.get(key) === entry) inputs.delete(key);
  }
}
