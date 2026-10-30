import { markAttachmentsSent, type InputAttachmentMeta } from "../attachment-service.js";
import { stablePromptHash } from "../client-message-id.js";
import { materializeMobileAttachments } from "./mobile-attachments.js";
import {
  injectMobileRunAndAwaitAcceptance,
  type MobileRunBridge,
  type MobileRunAcceptance,
  type MobileRunRequest,
} from "./mobile-run-dispatch.js";
import type { ClaimedMobileUpload, MobileUploadService } from "./mobile-upload-service.js";
import type { MobileAttachmentSummary, MobileImageAttachment, PermissionMode } from "./types.js";
import type { WorkerFrameMeta } from "../worker-bridge-core.js";

type ChatTurnUploads = Pick<MobileUploadService, "claim" | "release" | "finalize">;

export interface DispatchMobileChatTurnInput {
  deviceId: string;
  sessionId: string;
  fallbackCwd: string;
  projectId?: string;
  rootId?: string;
  text: string;
  attachments?: MobileImageAttachment[];
  clientMessageId?: string;
  modelTraceSource?: string;
  /** Host-resolved per-run model pool key; never a global model setting. */
  model?: string;
  configuredModel?: import("@cjhyy/code-shell-core/internal").ConfiguredTextModelIntent;
  workspaceProfile?: string;
  permissionMode?: PermissionMode;
  runId: string;
  bridge: MobileRunBridge;
  meta: WorkerFrameMeta;
  uploads: ChatTurnUploads;
  resolveWorkspace: (sessionId: string, fallbackCwd: string) => Promise<string>;
  markSent?: typeof markAttachmentsSent;
  /** Host-owned alternative producer; receives the same materialized input and ack boundary. */
  submit?: (request: MobileRunRequest) => Promise<MobileRunAcceptance>;
}

export type DispatchMobileChatTurnResult =
  | {
      ok: true;
      cwd: string;
      clientMessageId: string;
      metas: InputAttachmentMeta[];
      summaries: MobileAttachmentSummary[];
    }
  | { ok: false; message: string; uncertain?: false }
  | { ok: false; message: string; uncertain: true; clientMessageId: string };

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
  const suppliedClientMessageId = input.clientMessageId?.trim();
  if (suppliedClientMessageId && suppliedClientMessageId.length > 200) {
    await settleClaims(input.uploads, input.deviceId, materialized.claims, "release");
    return { ok: false, message: "clientMessageId is too long" };
  }
  const clientMessageId =
    suppliedClientMessageId ||
    `mobile:${input.sessionId}:${input.runId}:${stablePromptHash(`${text}\0${attachmentHash}`)}`;
  const request: MobileRunRequest = {
    id: input.runId,
    params: {
      task: text,
      ...(input.model ? { model: input.model } : {}),
      ...(input.configuredModel ? { configuredModel: { ...input.configuredModel } } : {}),
      ...(input.workspaceProfile ? { workspaceProfile: input.workspaceProfile } : {}),
      ...(input.modelTraceSource && /^panel:[a-z][a-z0-9-]{0,63}$/.test(input.modelTraceSource)
        ? { modelTraceSource: input.modelTraceSource }
        : {}),
      cwd,
      sessionId: input.sessionId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
      clientMessageId,
      attachments: materialized.metas,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    },
  };
  let acceptance: MobileRunAcceptance;
  try {
    acceptance = input.submit
      ? await input.submit(request)
      : await injectMobileRunAndAwaitAcceptance(input.bridge, request, input.meta);
  } catch {
    acceptance = {
      ok: false,
      uncertain: true,
      message: "The selected runtime did not confirm the submission",
    };
  }
  if (!acceptance.ok) {
    // Worker input refers to the canonical staged files, not these temporary
    // upload spools. Keep the staged files for a possibly accepted run and
    // release only the claims so the same intent can retry its attachments.
    // A late acceptance may never be observed, so uncertain files also need
    // sent retention rather than expiring as abandoned drafts after one day.
    if (acceptance.uncertain)
      await (input.markSent ?? markAttachmentsSent)(cwd, input.sessionId, materialized.metas).catch(
        () => undefined,
      );
    await settleClaims(input.uploads, input.deviceId, materialized.claims, "release");
    return acceptance.uncertain
      ? { ok: false, message: acceptance.message, uncertain: true, clientMessageId }
      : { ok: false, message: acceptance.message };
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
