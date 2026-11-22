import type { BrowserWindow } from "electron";
import {
  markAttachmentsSent,
  stageFileBytes,
  stageImageBytes,
  type InputAttachmentMeta,
} from "@cjhyy/code-shell-server/storage";
import type { PetChatEvent } from "../../preload/pet-api.js";
import type { PetChatControlRequest, PetChatControlResult } from "../im-gateway-control-server.js";
import { resolveNoRepoCwd } from "../agent-bridge.js";
import { PET_CHAT_EVENT_CHANNEL } from "../pet/pet-ipc.js";
import type { PetNoticeWiring } from "../pet/pet-notice-wiring.js";
import type { PetImDecisions } from "../pet/pet-im-decisions.js";
import type { NativeMimiDispatch } from "../desktop-host/mimi-dispatch-client.js";
import type { MimiDispatchService } from "../../shared/mimi-dispatch.js";

interface MimiGatewayShellOptions {
  host: Pick<NativeMimiDispatch, "gatewayTurn">;
  dispatcher(): MimiDispatchService | null;
  decisions(): PetImDecisions | null;
  notices(): PetNoticeWiring | null;
  windows(): BrowserWindow[];
}
export async function dispatchGatewayPetChat(
  options: MimiGatewayShellOptions,
  request: PetChatControlRequest,
): Promise<PetChatControlResult> {
  const dispatcher = options.dispatcher();
  if (!dispatcher) throw new Error("Mimi Pet 尚未就绪，请稍后重试");
  const sessionId = await dispatcher.getSessionId();
  // A reply to an open item (a decision prompt, a goal pause, a result) is read
  // against those items first, before Mimi, a Session binding or the chat
  // scheduler can take it as a new task or as inferred authorization.
  const decisionReply = await options.decisions()?.reply(request);
  if (typeof decisionReply === "string") return { text: decisionReply, petSessionId: sessionId };
  // "交给 Mimi": Mimi's turn gets the notice's data with the owner's request;
  // the item is used once that turn is dispatched, and freed if it never is.
  try {
    const attachments = await stageGatewayAttachments(request, sessionId);
    const replay = options.notices()?.inboundReplay(request.origin);
    const publish = (
      event: Extract<PetChatEvent, { kind: "user-submitted" | "host-action-completed" }>,
    ) => {
      for (const win of options.windows())
        if (!win.isDestroyed()) win.webContents.send(PET_CHAT_EVENT_CHANNEL, event);
    };
    try {
      return await options.host.gatewayTurn(
        {
          sessionId,
          message: request.message,
          origin: request.origin,
          handoff: decisionReply?.handoff,
          attachments,
        },
        {
          submitted: publish,
          completed: publish,
          dispatched: () => {
            replay?.finish();
            void decisionReply?.dispatched();
          },
          attachmentsSent: () => markAttachmentsSent(resolveNoRepoCwd(), sessionId, attachments),
        },
        replay,
      );
    } finally {
      replay?.finish();
    }
  } finally {
    decisionReply?.abandoned();
  }
}

async function stageGatewayAttachments(request: PetChatControlRequest, sessionId: string) {
  const cwd = resolveNoRepoCwd();
  const attachments: InputAttachmentMeta[] = [];
  let totalBytes = 0;
  for (const input of request.attachments ?? []) {
    const bytes = decodeGatewayAttachment(input.dataBase64, input.size);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) {
      throw new Error("IM 附件超过大小限制");
    }
    if (input.kind === "image") {
      attachments.push(
        await stageImageBytes({
          cwd,
          sessionId,
          name: input.name,
          mime: input.mimeType ?? "application/octet-stream",
          bytes,
          origin: "im-gateway",
        }),
      );
    } else {
      attachments.push(
        await stageFileBytes({
          cwd,
          sessionId,
          name: input.name,
          mime: input.mimeType,
          bytes,
          origin: "im-gateway",
        }),
      );
    }
  }

  return attachments;
}

function decodeGatewayAttachment(dataBase64: string, expectedSize: number): Buffer {
  if (
    dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) ||
    dataBase64.length > 28 * 1024 * 1024
  ) {
    throw new Error("IM 附件不是有效的 base64 数据");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength !== expectedSize) throw new Error("IM 附件大小校验失败");
  return bytes;
}
