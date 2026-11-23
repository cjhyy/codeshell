import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import type {
  PetChatControlRequest,
  PetChatControlResult,
} from "../main/im-gateway-control-server.js";
import type { PetChatEvent } from "../preload/pet-api.js";
import type { PetHostActionReceiptRecorder } from "../main/pet/pet-host-action-completion.js";
import type { enrichPetChatReplyWithHostActions } from "../main/pet/host-action-reply.js";

export type MimiGatewayInput = Pick<PetChatControlRequest, "message" | "origin"> & {
  sessionId: string;
  attachments: InputAttachmentMeta[];
  handoff?: string;
};
export interface MimiGatewayNative {
  submitted(event: Extract<PetChatEvent, { kind: "user-submitted" }>): void;
  dispatched(): void;
  attachmentsSent(): Promise<void>;
  completed(event: Extract<PetChatEvent, { kind: "host-action-completed" }>): void;
}
export type MimiGatewayResult = PetChatControlResult;
export type MimiReplyRender = {
  baseText: string;
  executions: Parameters<typeof enrichPetChatReplyWithHostActions>[1];
  options: Omit<Parameters<typeof enrichPetChatReplyWithHostActions>[2], "qrDir">;
};
export interface MimiReplyOperations {
  "mimi/renderReply": {
    input: MimiReplyRender;
    result: Awaited<ReturnType<typeof enrichPetChatReplyWithHostActions>>;
  };
  "mimi/recordReceipt": {
    input: Parameters<PetHostActionReceiptRecorder["record"]>[0];
    result: Awaited<ReturnType<PetHostActionReceiptRecorder["record"]>>;
  };
}
