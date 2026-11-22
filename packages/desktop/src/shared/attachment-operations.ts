import type { InputAttachmentMeta, StageImageDataUrlInput } from "@cjhyy/code-shell-server/storage";
type Scoped = { cwd: string; sessionId?: string };
export interface AttachmentOperations {
  "attachments/stage": { input: StageImageDataUrlInput; result: InputAttachmentMeta };
  "attachments/inspect": { input: Scoped; result: InputAttachmentMeta[] };
  "attachments/cleanup": {
    input: Scoped;
    result: { removed: string[]; sessionsRemoved: string[] };
  };
  "attachments/cleanupQuickChat": {
    input: { cwd: string; sessionId: string; device: number; inode: number };
    result: void;
  };
  "attachments/markSent": {
    input: { cwd: string; sessionId: string; attachments: InputAttachmentMeta[] };
    result: void;
  };
  "images/read": {
    input: { path: string; cwd?: string; sessionId?: string };
    result: string | null;
  };
  "images/exportName": { input: { src: string; name?: string; mime?: string }; result: string };
  "images/writePicked": { input: { src: string; filePath: string }; result: void };
}
