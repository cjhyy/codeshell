import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

function receiptFile(
  directory: string,
  receipt: { clientDeviceId: string; clientMessageId: string },
) {
  const key = createHash("sha256")
    .update(JSON.stringify([receipt.clientDeviceId, receipt.clientMessageId]))
    .digest("hex");
  return join(directory, `.input-${key}.pending`);
}
export class UncertainRoomInput extends Error {
  readonly code = "ROOM_INPUT_ACCEPTED";
  constructor() {
    super("上一笔同 ID 消息的 CLI 执行结果尚未确认。请先核对会话记录，不要重复发送。");
  }
}
export function assertRoomInputAvailable(
  directory: string,
  receipt: Parameters<typeof receiptFile>[1],
) {
  if (lstatSync(receiptFile(directory, receipt), { throwIfNoEntry: false }))
    throw new UncertainRoomInput();
}
/** A small reservation bridges the gap between the physical CLI write and its
 * durable history row. Only the accepted history row acknowledges a replay.
 * A crash with only the reservation returns uncertainty without another send. */
export function reserveRoomInput(
  directory: string,
  receipt: Parameters<typeof receiptFile>[1],
  syncDirectory: (directory: string) => void,
) {
  const path = receiptFile(directory, receipt);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UncertainRoomInput();
    throw error;
  }
  try {
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(directory);
  } catch (error) {
    unlinkSync(path);
    throw error;
  }
  return () => unlinkSync(path);
}
