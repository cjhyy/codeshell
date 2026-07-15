import { stageImageBytes, type InputAttachmentMeta } from "../attachment-service.js";
import type { MobileAttachmentSummary, MobileImageAttachment, MobileImageMime } from "./types.js";
import type { ClaimedMobileUpload, MobileUploadService } from "./mobile-upload-service.js";

export const MAX_MOBILE_ATTACHMENTS = 4;
export const MAX_MOBILE_INLINE_IMAGE_BYTES = 256 * 1024;
export const MAX_MOBILE_INLINE_TOTAL_BYTES = 512 * 1024;
export const MAX_MOBILE_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIMES = new Set<MobileImageMime>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

interface MaterializeInput {
  deviceId: string;
  cwd: string;
  sessionId: string;
  attachments?: MobileImageAttachment[];
  uploads: Pick<MobileUploadService, "claim" | "release">;
}

interface PreparedInline {
  descriptor: MobileImageAttachment & { transport: "inline" };
  bytes: Buffer;
}

interface PreparedUpload {
  descriptor: MobileImageAttachment & { transport: "upload" };
  upload: ClaimedMobileUpload;
}

function decodeInline(descriptor: MobileImageAttachment & { transport: "inline" }): Buffer {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(descriptor.dataUrl);
  if (!match || String(match[1]).toLowerCase() !== descriptor.mime) {
    throw new Error("inline image MIME does not match its data URL");
  }
  const base64 = String(match[2] ?? "").replace(/\s+/g, "");
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("invalid inline image base64");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength !== descriptor.size) {
    throw new Error("inline image size does not match its decoded bytes");
  }
  if (bytes.byteLength > MAX_MOBILE_INLINE_IMAGE_BYTES) {
    throw new Error("inline image exceeds the inline size limit");
  }
  return bytes;
}

function assertBaseFields(descriptor: MobileImageAttachment): void {
  if (!descriptor.clientId?.trim()) throw new Error("attachment clientId is required");
  if (!descriptor.name?.trim()) throw new Error("attachment name is required");
  if (!ALLOWED_MIMES.has(descriptor.mime)) throw new Error("unsupported image MIME");
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
    throw new Error("attachment size is invalid");
  }
}

/** Validate phone descriptors, resolve spools, and stage canonical attachment metadata. */
export async function materializeMobileAttachments(input: MaterializeInput): Promise<{
  metas: InputAttachmentMeta[];
  claims: ClaimedMobileUpload[];
  summaries: MobileAttachmentSummary[];
}> {
  const descriptors = input.attachments ?? [];
  if (descriptors.length > MAX_MOBILE_ATTACHMENTS) {
    throw new Error(`at most ${MAX_MOBILE_ATTACHMENTS} image attachments are allowed`);
  }
  const seen = new Set<string>();
  const prepared: Array<PreparedInline | PreparedUpload> = [];
  const claims: ClaimedMobileUpload[] = [];
  let inlineTotal = 0;
  let total = 0;

  try {
    for (const descriptor of descriptors) {
      assertBaseFields(descriptor);
      if (seen.has(descriptor.clientId)) throw new Error("duplicate attachment clientId");
      seen.add(descriptor.clientId);
      if (descriptor.transport === "inline") {
        const bytes = decodeInline(descriptor);
        inlineTotal += bytes.byteLength;
        total += bytes.byteLength;
        prepared.push({ descriptor, bytes });
      } else if (descriptor.transport === "upload") {
        if (!descriptor.uploadId?.trim()) throw new Error("uploadId is required");
        const upload = input.uploads.claim(input.deviceId, descriptor.uploadId);
        claims.push(upload);
        if (
          upload.clientId !== descriptor.clientId ||
          upload.name !== descriptor.name ||
          upload.mime !== descriptor.mime ||
          upload.size !== descriptor.size
        ) {
          throw new Error("uploaded image metadata does not match its descriptor");
        }
        total += upload.size;
        prepared.push({ descriptor, upload });
      } else {
        throw new Error("unsupported attachment transport");
      }
    }
    if (inlineTotal > MAX_MOBILE_INLINE_TOTAL_BYTES) {
      throw new Error("inline image total exceeds the message limit");
    }
    if (total > MAX_MOBILE_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("image attachment total exceeds the message limit");
    }

    const metas: InputAttachmentMeta[] = [];
    for (const item of prepared) {
      const common = {
        cwd: input.cwd,
        sessionId: input.sessionId,
        name: item.descriptor.name,
        mime: item.descriptor.mime,
        origin: "mobile" as const,
      };
      if ("bytes" in item) {
        metas.push(await stageImageBytes({ ...common, bytes: item.bytes }));
      } else {
        metas.push(await stageImageBytes({ ...common, sourceFile: item.upload.path }));
      }
    }
    return {
      metas,
      claims,
      summaries: descriptors.map(({ clientId, name, mime, size }) => ({
        clientId,
        name,
        mime,
        size,
      })),
    };
  } catch (error) {
    await Promise.allSettled(
      claims.map((claim) => input.uploads.release(input.deviceId, claim.uploadId, claim.claimId)),
    );
    throw error;
  }
}
