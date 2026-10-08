/** Shared browser-only user input projection for live and durable replay. */
import type { UserAttachmentSummary } from "./streamReducer.js";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentBlocks(value: unknown): ObjectValue[] {
  return Array.isArray(value)
    ? value.map(object).filter((block): block is ObjectValue => block !== undefined)
    : [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return contentBlocks(value)
    .filter((block) => block.type === "text")
    .map((block) => text(block.text))
    .join("");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attachmentName(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "附件";
  // The canonical staging service prefixes a content hash; it is not part of
  // the filename the user selected. Other paths keep their original basename.
  return path.includes(".code-shell/attachments/") ? name.replace(/^[a-f0-9]{16}-/, "") : name;
}

function byteSize(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/** Hide engine attachment plumbing while retaining attachment-only messages. */
export function transcriptUserDisplay(
  data: ObjectValue,
  options: { includeAbsolutePaths?: boolean; cwd?: string } = {},
): {
  text: string;
  attachments: UserAttachmentSummary[];
} {
  const attachments: UserAttachmentSummary[] = [];
  const absolutePath = (path: string): string =>
    /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path) || !options.cwd
      ? path
      : `${options.cwd.replace(/[\\/]$/, "")}/${path}`;
  const imagePaths: string[] = [];
  let raw = textContent(data.content);
  raw = raw.replace(
    /<attached-file\s+path="([^"]*)">\s*([\s\S]*?)<\/attached-file>/g,
    (match, path: string, metadata: string) => {
      if (!/^absolutePath:\s*.+$/m.test(metadata) || !/^origin:\s*.+$/m.test(metadata)) {
        return match;
      }
      const mime = metadata.match(/^mime:\s*(.+)$/m)?.[1]?.trim();
      attachments.push({
        name: attachmentName(unescapeAttribute(path)),
        path: unescapeAttribute(path),
        ...(options.includeAbsolutePaths
          ? { absPath: metadata.match(/^absolutePath:\s*(.+)$/m)![1]!.trim() }
          : {}),
        size: byteSize(metadata.match(/^size:\s*(\d+)\s*$/m)?.[1]),
        ...(mime ? { mime } : {}),
      });
      return "";
    },
  );
  raw = raw.replace(
    /<attached-directory\s+path="([^"]*)"[^>]*>[\s\S]*?<\/attached-directory>/g,
    (_match, path: string) => {
      attachments.push({
        name: `${attachmentName(unescapeAttribute(path))}/`,
        path: unescapeAttribute(path),
        ...(options.includeAbsolutePaths ? { absPath: absolutePath(unescapeAttribute(path)) } : {}),
        size: 0,
      });
      return "";
    },
  );
  raw = raw.replace(
    /<attached-image-paths>\s*([\s\S]*?)<\/attached-image-paths>\s*(?:\(上面附带的图片在工作区的真实路径[^\n]*\))?/g,
    (_match, paths: string) => {
      imagePaths.push(
        ...paths
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean),
      );
      return "";
    },
  );
  const imageBlocks = contentBlocks(data.content).filter((block) => block.type === "image");
  for (let index = 0; index < Math.max(imageBlocks.length, imagePaths.length); index++) {
    const source = object(imageBlocks[index]?.source);
    const encoded = text(source?.data).replace(/\s/g, "");
    attachments.push({
      name: imagePaths[index] ? attachmentName(imagePaths[index]) : `图片 ${index + 1}`,
      ...(imagePaths[index] ? { path: imagePaths[index] } : {}),
      ...(options.includeAbsolutePaths && imagePaths[index]
        ? { absPath: absolutePath(imagePaths[index]) }
        : {}),
      size: encoded
        ? Math.max(
            0,
            Math.floor((encoded.length * 3) / 4) - (encoded.match(/=+$/)?.[0].length ?? 0),
          )
        : byteSize(source?.byteLength),
      ...(typeof source?.media_type === "string" ? { mime: source.media_type } : {}),
    });
  }
  const explicit = Array.isArray(data.attachments)
    ? data.attachments.flatMap((item) => {
        const attachment = object(item);
        const name = text(attachment?.name) || text(attachment?.originalName);
        return name
          ? [
              {
                name,
                size: byteSize(attachment?.size),
                ...(typeof attachment?.mime === "string" ? { mime: attachment.mime } : {}),
                ...(typeof attachment?.path === "string" ? { path: attachment.path } : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    text: typeof data.displayText === "string" ? data.displayText : raw.trim(),
    attachments: explicit.length ? explicit : attachments,
  };
}

/** Apply the canonical display projection without copying image payloads. */
export function projectOutputUserEvent<T extends { type?: unknown; transcriptMessage?: unknown }>(
  event: T,
): T {
  if (event.type !== "session_user_message" && event.type !== "steer_injected") return event;
  const message = object(event.transcriptMessage);
  return message
    ? {
        ...event,
        ...transcriptUserDisplay(message, {
          includeAbsolutePaths: true,
          ...(typeof message.cwd === "string" ? { cwd: message.cwd } : {}),
        }),
      }
    : event;
}
