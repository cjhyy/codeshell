import type { PetHostActionReceiptStore } from "../main/pet/pet-host-action-receipts.js";
import type { PetChatAttachmentContext } from "../main/pet/pet-chat-attachment-context.js";
import type { PetContextLinkStore } from "../main/pet/pet-context-links.js";
import type { PetReportReceiptStore } from "../main/pet/pet-report-receipt-store.js";
interface MimiTurnOperations {
  loadReceipts: PetHostActionReceiptStore["load"];
  claim: PetHostActionReceiptStore["claim"];
  complete: PetHostActionReceiptStore["record"];
  rememberAttachments: PetChatAttachmentContext["remember"];
  attachments: PetChatAttachmentContext["list"];
  clearAttachments: PetChatAttachmentContext["clear"];
  linkContext: PetContextLinkStore["record"];
  linkedContexts: PetContextLinkStore["query"];
  delivered: PetReportReceiptStore["has"];
  markDelivered: PetReportReceiptStore["mark"];
}
export type MimiTurnStorageCommand = {
  [K in keyof MimiTurnOperations]: { action: K; args: Parameters<MimiTurnOperations[K]> };
}[keyof MimiTurnOperations];
/** Typed clients usable from the Host or Main. The file-owning worker alone resolves paths. */
export function mimiTurnStores(send: (command: MimiTurnStorageCommand) => Promise<unknown>) {
  function method<K extends keyof MimiTurnOperations>(action: K) {
    return (...args: Parameters<MimiTurnOperations[K]>) =>
      send({ action, args } as MimiTurnStorageCommand) as ReturnType<MimiTurnOperations[K]>;
  }
  return {
    receipts: { load: method("loadReceipts"), claim: method("claim"), record: method("complete") },
    attachmentContext: {
      remember: method("rememberAttachments"),
      list: method("attachments"),
      clear: method("clearAttachments"),
    },
    contextLinks: { record: method("linkContext"), query: method("linkedContexts") },
    reports: { has: method("delivered"), mark: method("markDelivered") },
  };
}
