import { markAttachmentsSent, type InputAttachmentMeta } from "../attachment-service.js";
import { stablePromptHash } from "../client-message-id.js";
import { materializeMobileAttachments } from "./mobile-attachments.js";
import { injectMobileRunAndAwaitAcceptance, type MobileRunBridge } from "./mobile-run-dispatch.js";
import type { ClaimedMobileUpload, MobileUploadService } from "./mobile-upload-service.js";
import type { MobileAttachmentSummary, MobileImageAttachment, PermissionMode } from "./types.js";

type ChatTurnUploads = Pick<MobileUploadService, "claim" | "release" | "finalize">;

export interface DispatchMobileChatTurnInput {
  deviceId: string;
  sessionId: string;
  fallbackCwd: string;
  text: string;
  attachments?: MobileImageAttachment[];
  permissionMode?: PermissionMode;
  runId: string;
  bridge: MobileRunBridge;
  uploads: ChatTurnUploads;
  resolveWorkspace: (sessionId: string, fallbackCwd: string) => Promise<string>;
  markSent?: typeof markAttachmentsSent;
}

export type DispatchMobileChatTurnResult =
  | {
      ok: true;
      cwd: string;
      clientMessageId: string;
      metas: InputAttachmentMeta[];
      summaries: MobileAttachmentSummary[];
    }
  | { ok: false; message: string };

async function settleClaims(
  uploads: ChatTurnUploads,
  deviceId: string,
  claims: ClaimedMobileUpload[],
  action: "release" | "finalize",
): Promise<void> {
  await Promise.allSettled(
    claims.map((claim) => uploads[action](deviceId, claim.uploadId, claim.claimId)),
  );
}

/** Transaction boundary for mobile chat: workspace → canonical stage → worker ack → finalize. */
export async function dispatchMobileChatTurn(
  input: DispatchMobileChatTurnInput,
): Promise<DispatchMobileChatTurnResult> {
  let cwd: string;
  try {
    cwd = await input.resolveWorkspace(input.sessionId, input.fallbackCwd);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  let materialized;
  try {
    materialized = await materializeMobileAttachments({
      deviceId: input.deviceId,
      cwd,
      sessionId: input.sessionId,
      attachments: input.attachments,
      uploads: input.uploads,
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const text = input.text.trim();
  if (!text && materialized.metas.length === 0) {
    await settleClaims(input.uploads, input.deviceId, materialized.claims, "release");
    return { ok: false, message: "消息必须包含文字或图片" };
  }

  const attachmentHash = materialized.metas.map((meta) => meta.sha256).join(":");
  const clientMessageId = `mobile:${input.sessionId}:${input.runId}:${stablePromptHash(`${text}\0${attachmentHash}`)}`;
  const acceptance = await injectMobileRunAndAwaitAcceptance(input.bridge, {
    id: input.runId,
    params: {
      task: text,
      cwd,
      sessionId: input.sessionId,
      clientMessageId,
      attachments: materialized.metas,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    },
  });
  if (!acceptance.ok) {
    await settleClaims(input.uploads, input.deviceId, materialized.claims, "release");
    return { ok: false, message: acceptance.message };
  }

  await (input.markSent ?? markAttachmentsSent)(cwd, input.sessionId, materialized.metas).catch(
    () => undefined,
  );
  await settleClaims(input.uploads, input.deviceId, materialized.claims, "finalize");
  return {
    ok: true,
    cwd,
    clientMessageId,
    metas: materialized.metas,
    summaries: materialized.summaries,
  };
}
