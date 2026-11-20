/**
 * The path-reference block appended to an external-runtime (Codex / Claude
 * Code) turn so the CLI knows which local files the user attached. The model
 * needs it; a chat bubble must not show it. The writer and the display parser
 * live together so the format cannot drift.
 */
export type AttachmentReferenceKind = "image" | "file" | "directory";

export interface AttachmentReference {
  kind: AttachmentReferenceKind;
  path: string;
}

const OPEN = "<codeshell_attachments>";
const CLOSE = "</codeshell_attachments>";
const INTRO = "The user explicitly attached these local paths. Inspect them when relevant:";

export function formatAttachmentReferences(
  text: string,
  references: readonly AttachmentReference[],
): string {
  const lines = references
    .filter((reference) => reference.path.trim())
    .map((reference) => `- ${reference.kind}: ${reference.path}`);
  if (lines.length === 0) return text;
  return [text, "", OPEN, INTRO, ...lines, CLOSE].join("\n");
}

/**
 * Split a persisted turn back into what the user typed and what they attached.
 * Only a trailing block in exactly the written shape is recognised; anything
 * else is returned unchanged.
 */
export function splitAttachmentReferences(content: string): {
  text: string;
  references: AttachmentReference[];
} {
  const end = content.trimEnd();
  if (!end.endsWith(CLOSE)) return { text: content, references: [] };
  const start = end.lastIndexOf(`\n${OPEN}\n`);
  const opensAtStart = start === -1 && end.startsWith(`${OPEN}\n`);
  if (start === -1 && !opensAtStart) return { text: content, references: [] };
  const bodyStart = opensAtStart ? OPEN.length + 1 : start + OPEN.length + 2;
  const lines = end.slice(bodyStart, end.length - CLOSE.length).split("\n");
  if (lines[0] !== INTRO) return { text: content, references: [] };
  const references: AttachmentReference[] = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const match = /^- (image|file|directory): (.+)$/u.exec(line);
    if (!match) return { text: content, references: [] };
    references.push({ kind: match[1] as AttachmentReferenceKind, path: match[2]! });
  }
  if (references.length === 0) return { text: content, references: [] };
  const text = opensAtStart ? "" : end.slice(0, start).replace(/\n+$/u, "");
  return { text, references };
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** Display metadata for a `session_user_message`; never file contents. */
export function attachmentReferenceDisplay(reference: AttachmentReference): {
  name: string;
  size: number;
  path: string;
  absPath: string;
  mime?: string;
} {
  const base = reference.path.split(/[\\/]/u).filter(Boolean).pop() ?? reference.path;
  const extension = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const mime = reference.kind === "image" ? (IMAGE_MIME[extension] ?? "image/*") : undefined;
  return {
    name: reference.kind === "directory" ? `${base}/` : base,
    size: 0,
    path: reference.path,
    absPath: reference.path,
    ...(mime ? { mime } : {}),
  };
}
