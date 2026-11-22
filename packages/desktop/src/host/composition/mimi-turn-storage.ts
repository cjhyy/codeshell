import { join } from "node:path";
import { PetHostActionReceiptStore } from "../../main/pet/pet-host-action-receipts.js";
import { PetChatAttachmentContext } from "../../main/pet/pet-chat-attachment-context.js";
import { PetContextLinkStore } from "../../main/pet/pet-context-links.js";
import { PetReportReceiptStore } from "../../main/pet/pet-report-receipt-store.js";
import type { MimiTurnStorageCommand } from "../../shared/mimi-turn-storage.js";

/** Single storage-worker owner shared by chat, recovery and native Session reports. */
export function storedMimiTurns(dir: string) {
  const receipts = new PetHostActionReceiptStore(join(dir, "host-action-receipts.json"));
  const attachments = new PetChatAttachmentContext(dir);
  const contexts = new PetContextLinkStore(join(dir, "context-links.json"));
  const reports = new PetReportReceiptStore(join(dir, "report-receipts.json"));
  return async (cmd: MimiTurnStorageCommand) => {
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
  };
}
