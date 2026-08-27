import { Transcript } from "@cjhyy/code-shell-core";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX,
  PET_HOST_ACTION_REPLACE_CLIENT_ID_PREFIX,
  PET_HOST_ACTION_REPLACE_DELIVERY_CLIENT_ID_PREFIX,
} from "../../shared/pet-host-action-receipt.js";
import { enrichPetChatReplyWithHostActions } from "./host-action-reply.js";
import type { PetHostActionExecution } from "./pet-dispatch-service.js";

export interface PetHostActionReceiptRecordInput {
  petSessionId: string;
  clientMessageId: string;
  executions: PetHostActionExecution[];
  /** Trusted host text to use before rendering any host-action outcomes. */
  baseMessage?: string;
  /**
   * A host-rendered final reply that is already authoritative for this route.
   * Gateway uses this for SendMessage so persistence, HTTP, and the Mimi UI all
   * display the exact same platform outcome without rendering it twice.
   */
  authoritativeMessage?: string;
  /** Replace the model's final acknowledgement with this authoritative reply. */
  replaceAssistant?: boolean;
  /** Channel that accepted the displayed reply, used only for the delivery tip. */
  deliveryChannel?: string;
  /** Persist a host-handled control turn whose user message never reached Engine.run. */
  userMessage?: string;
}

export interface PetHostActionReceiptResult {
  message: string;
  replaceAssistant?: boolean;
  deliveryChannel?: string;
}

export interface PetHostActionReceiptRecorder {
  record(input: PetHostActionReceiptRecordInput): Promise<PetHostActionReceiptResult | null>;
}

export interface PetHostActionCompletedEvent extends PetHostActionReceiptResult {
  kind: "host-action-completed";
  clientMessageId: string;
  createdAt: number;
}

export class PetHostActionReceiptService implements PetHostActionReceiptRecorder {
  constructor(
    private readonly options: {
      sessionsRootDir: string;
      qrDir: string;
      onPersistError?: (error: unknown, input: PetHostActionReceiptRecordInput) => void;
    },
  ) {}

  async record(input: PetHostActionReceiptRecordInput): Promise<PetHostActionReceiptResult | null> {
    const renderedMessage =
      input.authoritativeMessage === undefined
        ? (
            await enrichPetChatReplyWithHostActions(input.baseMessage ?? "", input.executions, {
              qrDir: this.options.qrDir,
              attachmentKinds: [],
              authoritativeBaseText: Boolean(input.baseMessage?.trim()),
            })
          ).text
        : input.authoritativeMessage;
    const message = renderedMessage.trim();
    if (!message) return null;
    const replaceAssistant =
      input.replaceAssistant ??
      (Boolean(input.baseMessage?.trim()) ||
        input.executions.some((execution) => execution.kind === "outboundMessage"));
    let deliveryChannel = input.deliveryChannel;
    if (!deliveryChannel) {
      const resultChannel = input.executions.find(
        (execution) =>
          execution.ok &&
          (execution.kind === "outboundMessage" || execution.kind === "gatewayReply") &&
          typeof execution.result?.channel === "string",
      )?.result?.channel;
      if (typeof resultChannel === "string") deliveryChannel = resultChannel;
    }
    try {
      const sessionDir = join(this.options.sessionsRootDir, input.petSessionId);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const transcript = new Transcript(join(sessionDir, "transcript.jsonl"));
      if (input.userMessage?.trim() && !transcript.hasClientMessageId(input.clientMessageId)) {
        transcript.appendMessage("user", input.userMessage.trim(), {
          clientMessageId: input.clientMessageId,
        });
      }
      transcript.appendMessage("assistant", message, {
        clientMessageId: replaceAssistant
          ? deliveryChannel
            ? `${PET_HOST_ACTION_REPLACE_DELIVERY_CLIENT_ID_PREFIX}${encodeURIComponent(
                deliveryChannel,
              )}:${input.clientMessageId}`
            : `${PET_HOST_ACTION_REPLACE_CLIENT_ID_PREFIX}${input.clientMessageId}`
          : `${PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX}${input.clientMessageId}`,
      });
    } catch (error) {
      this.options.onPersistError?.(error, input);
    }
    return {
      message,
      ...(replaceAssistant ? { replaceAssistant: true } : {}),
      ...(deliveryChannel ? { deliveryChannel } : {}),
    };
  }
}

/**
 * One completion boundary shared by Desktop IPC and Gateway-originated Mimi
 * turns. The recorder owns durable truth; this helper publishes that same
 * truth only after recording has been attempted.
 */
export async function completePetHostActionReceipt(options: {
  recorder: PetHostActionReceiptRecorder;
  input: PetHostActionReceiptRecordInput;
  publish: (event: PetHostActionCompletedEvent) => void;
  now?: () => number;
}): Promise<PetHostActionReceiptResult | null> {
  const receipt = await options.recorder.record(options.input);
  if (!receipt) return null;
  options.publish({
    kind: "host-action-completed",
    clientMessageId: options.input.clientMessageId,
    message: receipt.message,
    ...(receipt.replaceAssistant ? { replaceAssistant: true } : {}),
    ...(receipt.deliveryChannel ? { deliveryChannel: receipt.deliveryChannel } : {}),
    createdAt: options.now?.() ?? Date.now(),
  });
  return receipt;
}
