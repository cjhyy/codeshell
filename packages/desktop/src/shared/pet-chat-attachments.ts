/**
 * Renderer-safe projection of an input attachment received by Mimi. The
 * bytes stay on disk; this metadata is only used to show the user's original
 * attachment in the durable manager conversation.
 */
export interface PetChatAttachment {
  kind: "image" | "file" | "directory";
  path: string;
  absPath: string;
  sessionId: string;
  mime?: string;
  originalName?: string;
}
