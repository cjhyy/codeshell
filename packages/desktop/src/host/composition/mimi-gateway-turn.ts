import { randomUUID } from "node:crypto";
import { stablePromptHash } from "@cjhyy/code-shell-server/storage";
import type {
  MimiGatewayInput,
  MimiGatewayNative,
  MimiGatewayResult,
  MimiReplyOperations,
} from "../../shared/mimi-gateway-turn.js";
import type {
  PetDispatchService,
  PetPendingNoticeSource,
} from "../../main/pet/pet-dispatch-service.js";
import {
  completePetHostActionReceipt,
  type PetHostActionReceiptRecorder,
} from "../../main/pet/pet-host-action-completion.js";

export async function runMimiGatewayTurn(
  input: MimiGatewayInput,
  deps: {
    manager: Pick<PetDispatchService, "getSessionId" | "dispatch">;
    pending?: PetPendingNoticeSource;
    native: {
      [K in keyof MimiGatewayNative]: (...args: Parameters<MimiGatewayNative[K]>) => Promise<void>;
    };
    render(
      input: MimiReplyOperations["mimi/renderReply"]["input"],
    ): Promise<MimiReplyOperations["mimi/renderReply"]["result"]>;
    receipt: PetHostActionReceiptRecorder;
    onReceiptError(error: unknown): void;
  },
): Promise<MimiGatewayResult> {
  if (
    (await deps.manager.getSessionId()) !== input.sessionId ||
    input.attachments.some((file) => file.sessionId !== input.sessionId)
  )
    throw Error("Mimi gateway Session changed");
  const { origin, attachments } = input;
  const channel =
    origin?.channel
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .slice(0, 32) || "unknown";
  const clientMessageId = origin?.messageId
    ? `im:${channel}:${stablePromptHash([origin.channel, origin.target, origin.senderId, origin.messageId].join("\0"))}`
    : `im:${channel}:${randomUUID()}`;
  await deps.native.submitted({
    kind: "user-submitted",
    clientMessageId,
    message: input.message.trim(),
    createdAt: Date.now(),
    ...(origin && { origin }),
    ...(attachments.length > 0 && {
      attachments: attachments.map(({ kind, path, absPath, sessionId, mime, originalName }) => ({
        kind,
        path,
        absPath,
        sessionId,
        ...(mime && { mime }),
        ...(originalName && { originalName }),
      })),
    }),
  });
  const result = await deps.manager.dispatch({
    type: "chat",
    message: input.handoff ?? input.message,
    clientMessageId,
    ...(attachments.length > 0 && { attachments }),
    ...(deps.pending && { pendingNotices: deps.pending }),
    source: {
      kind: "im-gateway",
      channel,
      ...(origin?.senderId && { senderId: origin.senderId }),
      isDirectMessage: origin?.isDirectMessage === true,
      capabilities: origin?.capabilities ?? {
        inbound: { text: true, attachments: [] },
        outbound: { text: true, button: "link", attachments: [] },
      },
      ...(origin?.channels && { channels: origin.channels }),
      ...(origin && { target: origin.target }),
    },
  });
  if (!result.ok) throw Error(result.message ?? result.code);
  await deps.native.dispatched();
  if (result.type !== "chat") throw Error("Mimi Pet 返回了非聊天结果");
  await deps.native.attachmentsSent().catch(() => {});
  if (result.suppressReply)
    return { text: "", petSessionId: result.petSessionId, reason: "steered", suppressReply: true };
  const worker = result.result as { text?: unknown; reason?: unknown } | undefined;
  const enriched = await deps.render({
    baseText: result.authoritativeReply ?? (typeof worker?.text === "string" ? worker.text : ""),
    executions: result.hostActions,
    options: {
      authoritativeBaseText: !!result.authoritativeReply,
      attachmentKinds: origin?.capabilities.outbound.attachments.filter((kind) =>
        ["image", "file", "audio", "video"].includes(kind),
      ),
    },
  });
  const replaces =
    !!result.authoritativeReply ||
    !!result.hostActions?.some(
      (action) => action.kind === "gatewayReply" || action.kind === "sessionBind",
    );
  if (replaces || result.hostActions?.some((action) => action.kind === "outboundMessage")) {
    try {
      await completePetHostActionReceipt({
        recorder: deps.receipt,
        input: {
          petSessionId: result.petSessionId,
          clientMessageId,
          executions: result.hostActions ?? [],
          authoritativeMessage: enriched.text,
          ...(result.contextCleared && { userMessage: input.message.trim() }),
          ...(replaces && { replaceAssistant: true, deliveryChannel: channel }),
        },
        publish: (event) => deps.native.completed(event),
      });
    } catch (e) {
      deps.onReceiptError(e);
    }
  }
  return {
    text: enriched.text,
    petSessionId: result.petSessionId,
    ...(typeof worker?.reason === "string" && { reason: worker.reason }),
    ...(enriched.button && { button: enriched.button }),
    ...(enriched.attachments.length > 0 && { attachments: enriched.attachments }),
  };
}
