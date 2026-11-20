import { formatAttachmentReferences } from "@cjhyy/code-shell-core/internal";

/** Transport-neutral user input for Codex / Claude Code runtimes. */
export interface ExternalRuntimeAttachment {
  path: string;
  kind?: "image" | "file" | "directory";
  mime?: string;
  detail?: "low" | "standard" | "high";
}

export interface ExternalRuntimeTurnInput {
  text: string;
  /** Optional shorter text persisted/rendered for this turn; `text` still reaches the runtime. */
  displayText?: string;
  clientMessageId?: string;
  attachments?: readonly ExternalRuntimeAttachment[];
  /** Host-injected continuation (for example, a background-job completion). */
  injected?: boolean;
}

export function textWithAttachmentReferences(input: ExternalRuntimeTurnInput): string {
  return formatAttachmentReferences(
    input.text,
    (input.attachments ?? []).map((attachment) => ({
      kind: attachment.kind ?? "file",
      path: attachment.path,
    })),
  );
}
