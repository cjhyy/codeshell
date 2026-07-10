import type { MobileImageAttachment, MobileImageBase, MobileImageMime } from "@protocol";

export const MOBILE_INLINE_IMAGE_BYTES = 256 * 1024;
export const MOBILE_INLINE_TOTAL_BYTES = 512 * 1024;
export const MOBILE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MOBILE_MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MOBILE_MAX_ATTACHMENTS = 4;

const SUPPORTED_MIMES = new Set<MobileImageMime>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface MobileComposerAttachment {
  clientId: string;
  file: File;
}

export interface MobileUploadTicket {
  clientId: string;
  uploadId: string;
  putUrl: string;
  expiresAt: number;
}

interface PrepareOptions {
  beginUpload: (metadata: MobileImageBase) => Promise<MobileUploadTicket>;
  fetch: typeof fetch;
}

function jpegName(name: string): string {
  return /\.[^.]+$/.test(name) ? name.replace(/\.[^.]+$/, ".jpg") : `${name}.jpg`;
}

async function canvasJpeg(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new Error(`Unsupported image format: ${file.type || file.name}`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Unsupported image format: ${file.type || file.name}`);
  }
  try {
    const maxEdge = 4096;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (next) => (next ? resolve(next) : reject(new Error("Image conversion failed"))),
        "image/jpeg",
        0.88,
      ),
    );
    return new File([blob], jpegName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

export async function normalizeMobileImage(file: File): Promise<File> {
  const mime = file.type.toLowerCase();
  if (mime === "image/jpg") {
    return new File([await file.arrayBuffer()], file.name, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  }
  if (SUPPORTED_MIMES.has(mime as MobileImageMime) && file.size <= MOBILE_MAX_IMAGE_BYTES) {
    return file;
  }
  // Preserve supported animated GIFs rather than silently flattening them.
  if (mime === "image/gif") throw new Error("Image exceeds the 10 MiB limit");
  const converted = await canvasJpeg(file);
  if (converted.size > MOBILE_MAX_IMAGE_BYTES) throw new Error("Image exceeds the 10 MiB limit");
  return converted;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function dataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `data:${file.type};base64,${bytesToBase64(bytes)}`;
}

export async function prepareMobileAttachments(
  attachments: MobileComposerAttachment[],
  options: PrepareOptions,
): Promise<MobileImageAttachment[]> {
  if (attachments.length > MOBILE_MAX_ATTACHMENTS) {
    throw new Error(`At most ${MOBILE_MAX_ATTACHMENTS} images can be sent`);
  }
  const normalized: Array<{ clientId: string; file: File; mime: MobileImageMime }> = [];
  let total = 0;
  for (const attachment of attachments) {
    const file = await normalizeMobileImage(attachment.file);
    const mime = file.type.toLowerCase() as MobileImageMime;
    if (!SUPPORTED_MIMES.has(mime)) throw new Error(`Unsupported image format: ${file.type}`);
    total += file.size;
    normalized.push({ clientId: attachment.clientId, file, mime });
  }
  if (total > MOBILE_MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("Image attachments exceed the 20 MiB message limit");
  }

  const descriptors: MobileImageAttachment[] = [];
  let inlineBytes = 0;
  for (const { clientId, file, mime } of normalized) {
    const base: MobileImageBase = {
      clientId,
      name: file.name,
      mime,
      size: file.size,
    };
    if (
      file.size <= MOBILE_INLINE_IMAGE_BYTES &&
      inlineBytes + file.size <= MOBILE_INLINE_TOTAL_BYTES
    ) {
      descriptors.push({ ...base, transport: "inline", dataUrl: await dataUrl(file) });
      inlineBytes += file.size;
      continue;
    }
    const ticket = await options.beginUpload(base);
    const response = await options.fetch(ticket.putUrl, {
      method: "PUT",
      headers: { "Content-Type": mime },
      body: file,
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`Image upload failed (${response.status})`);
    descriptors.push({ ...base, transport: "upload", uploadId: ticket.uploadId });
  }
  return descriptors;
}
