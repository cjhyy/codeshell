import { useEffect, useState } from "react";

/** The subset of a saved attachment needed to show it. */
export interface DisplayAttachment {
  kind: "image" | "file" | "directory";
  absPath: string;
  sessionId?: string;
  originalName?: string;
  size?: number;
}

/** `<cwd>/.code-shell/attachments/<sessionId>/…` — the context Main authorizes reads by. */
function attachmentReadContext(path: string): { cwd?: string; sessionId?: string } {
  const match = /^(.*)[\\/]\.code-shell[\\/]attachments[\\/]([^\\/]+)[\\/]/u.exec(path);
  return match ? { cwd: match[1] || "/", sessionId: match[2] } : {};
}

/** Loads a saved image attachment through Main; `null` until it is readable. */
export function useAttachmentDataUrl(attachment: DisplayAttachment, enabled = true) {
  const [src, setSrc] = useState<string | null>(null);
  const image = enabled && attachment.kind === "image" && Boolean(attachment.absPath);
  useEffect(() => {
    if (!image) return;
    let live = true;
    const context = attachmentReadContext(attachment.absPath);
    const sessionId = attachment.sessionId || context.sessionId;
    void window.codeshell
      ?.readImageDataUrl?.(attachment.absPath, {
        ...(context.cwd ? { cwd: context.cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
      })
      .then((dataUrl) => {
        if (live && dataUrl) setSrc(dataUrl);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [image, attachment.absPath, attachment.sessionId]);
  return image ? src : null;
}
