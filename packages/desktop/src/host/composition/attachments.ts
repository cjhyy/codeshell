import { realpath, stat, writeFile } from "node:fs/promises";
import {
  cleanupAttachments,
  listRecentAttachments,
  markAttachmentsSent,
  stageImageDataUrl,
} from "@cjhyy/code-shell-server/storage";
import { requireRendererProjectPath } from "../../main/renderer-project-path.js";
import { requireRendererOrSessionPath } from "../../main/renderer-session-path.js";
import { readImageDataUrl } from "../../main/image-read-service.js";
import { parseDataUrl, suggestImageFilename } from "../../main/image-save.js";
import type { AttachmentOperations } from "../../shared/attachment-operations.js";
import { claimBusinessCommit, type BusinessGrant, type BusinessMethods } from "./business-calls.js";

function commitOnce(grant: BusinessGrant) {
  let claimed = false;
  return () => {
    if (claimed) return;
    claimBusinessCommit(grant.permit);
    claimed = true;
  };
}
function exportImage(src: string) {
  if (typeof src !== "string" || !src || src.length > Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1024)
    throw new Error("images:save requires a bounded data URL");
  const parsed = parseDataUrl(src);
  if (!parsed) throw new Error("images:save: src is not a data URL");
  return parsed;
}
export const attachmentOperations = {
  async "attachments/stage"(input, grant) {
    const cwd = await requireRendererProjectPath(input.cwd);
    grant.assertCurrent();
    return stageImageDataUrl({ ...input, cwd }, commitOnce(grant));
  },
  async "attachments/inspect"({ cwd, sessionId }, grant) {
    const path = await requireRendererProjectPath(cwd);
    grant.assertCurrent();
    return listRecentAttachments({ cwd: path, sessionId });
  },
  async "attachments/cleanup"({ cwd, sessionId }, grant) {
    const path = await requireRendererProjectPath(cwd);
    grant.assertCurrent();
    return cleanupAttachments({ cwd: path, sessionId }, commitOnce(grant));
  },
  async "attachments/cleanupQuickChat"({ cwd, sessionId, device, inode }, grant) {
    if (!sessionId.startsWith("qchat-") || (await realpath(cwd)) !== cwd) return;
    const info = await stat(cwd);
    if (!info.isDirectory() || info.dev !== device || info.ino !== inode) return;
    await cleanupAttachments({ cwd, sessionId }, commitOnce(grant));
  },
  async "attachments/markSent"({ cwd, sessionId, attachments }, grant) {
    const path = await requireRendererProjectPath(cwd);
    grant.assertCurrent();
    return markAttachmentsSent(path, sessionId, attachments, commitOnce(grant));
  },
  async "images/read"({ path, cwd, sessionId }, grant) {
    const root = cwd ? await requireRendererOrSessionPath(cwd, sessionId) : undefined;
    grant.assertCurrent();
    return readImageDataUrl(path, { cwd: root, sessionId });
  },
  "images/exportName"({ src, name, mime }) {
    const parsed = exportImage(src);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return suggestImageFilename({ name: name ?? null, mime: mime ?? parsed.mime, stamp });
  },
  async "images/writePicked"({ src, filePath }, grant) {
    const parsed = exportImage(src);
    claimBusinessCommit(grant.permit);
    await writeFile(filePath, parsed.buffer);
  },
} satisfies Pick<BusinessMethods, keyof AttachmentOperations>;
