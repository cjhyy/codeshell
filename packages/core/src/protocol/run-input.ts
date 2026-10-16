import type { RunParams, InputAttachmentMeta } from "./types.js";

/** Source is a label; it cannot select storage, workspace or session authority. */
export function runDiagnosticInputError(params: RunParams): string | null {
  return params.modelTraceSource !== undefined &&
    (typeof params.modelTraceSource !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(params.modelTraceSource))
    ? "modelTraceSource must be a bounded diagnostic label"
    : null;
}

export function isValidRunAttachment(value: unknown): value is InputAttachmentMeta {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<InputAttachmentMeta>;
  const hasPath = [attachment.path, attachment.relPath, attachment.absPath].some(
    (path) => typeof path === "string" && path.trim().length > 0,
  );
  return (
    typeof attachment.id === "string" &&
    attachment.id.length > 0 &&
    typeof attachment.sessionId === "string" &&
    attachment.sessionId.length > 0 &&
    (attachment.kind === "image" ||
      attachment.kind === "file" ||
      attachment.kind === "directory") &&
    hasPath
  );
}
