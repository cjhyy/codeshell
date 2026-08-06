/** Transport-neutral user input for Codex / Claude Code runtimes. */
export interface ExternalRuntimeAttachment {
  path: string;
  kind?: "image" | "file" | "directory";
  mime?: string;
  detail?: "low" | "standard" | "high";
}

export interface ExternalRuntimeTurnInput {
  text: string;
  clientMessageId?: string;
  attachments?: readonly ExternalRuntimeAttachment[];
}

export function textWithAttachmentReferences(input: ExternalRuntimeTurnInput): string {
  const references = (input.attachments ?? [])
    .filter((attachment) => attachment.path.trim())
    .map((attachment) => `- ${attachment.kind ?? "file"}: ${attachment.path}`);
  if (references.length === 0) return input.text;
  return [
    input.text,
    "",
    "<codeshell_attachments>",
    "The user explicitly attached these local paths. Inspect them when relevant:",
    ...references,
    "</codeshell_attachments>",
  ].join("\n");
}
