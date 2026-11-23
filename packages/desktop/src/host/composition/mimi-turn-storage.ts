import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { PetHostActionReceiptStore } from "../../main/pet/pet-host-action-receipts.js";
import { PetChatAttachmentContext } from "../../main/pet/pet-chat-attachment-context.js";
import { PetContextLinkStore } from "../../main/pet/pet-context-links.js";
import { PetReportReceiptStore } from "../../main/pet/pet-report-receipt-store.js";
import type { MimiTurnStorageCommand } from "../../shared/mimi-turn-storage.js";

/** Single storage-worker owner shared by chat, recovery and native Session reports. */
export function storedMimiTurns(dir: string) {
  const grants = new AsyncLocalStorage<Int32Array>();
  const replace = async (from: string, to: string) => {
    const permit = grants.getStore();
    if (!permit || Atomics.compareExchange(permit, 0, 0, 1) === -1)
      throw Error("Mimi turn write was withdrawn");
    renameSync(from, to);
  };
  const receipts = new PetHostActionReceiptStore(join(dir, "host-action-receipts.json"), replace);
  const attachments = new PetChatAttachmentContext(dir, replace);
  const contexts = new PetContextLinkStore(join(dir, "context-links.json"), replace);
  const reports = new PetReportReceiptStore(join(dir, "report-receipts.json"), Date.now, replace);
  return async ({ cmd, permit }: { cmd: MimiTurnStorageCommand; permit: Int32Array }) =>
    grants.run(permit, async () => {
      switch (cmd.action) {
        case "loadReceipts":
          return receipts.load();
        case "claim":
          return receipts.claim(...cmd.args);
        case "complete":
          return receipts.record(...cmd.args);
        case "rememberAttachments":
          return attachments.remember(...cmd.args);
        case "attachments":
          return attachments.list(...cmd.args);
        case "clearAttachments":
          return attachments.clear(...cmd.args);
        case "linkContext":
          return contexts.record(...cmd.args);
        case "linkedContexts":
          return contexts.query(...cmd.args);
        case "delivered":
          return reports.has(...cmd.args);
        case "markDelivered":
          return reports.mark(...cmd.args);
        default:
          throw Error("Unknown Mimi turn storage operation");
      }
    });
}
