import type { InputAttachmentMeta } from "../../preload/types";
import type { MentionReferences } from "./mentionReferences";

export interface ComposerMetadata {
  localFilePaths: string[];
  inputReferences: InputAttachmentMeta[];
  mentionReferences: MentionReferences;
  attachmentError: string | null;
}

export function emptyComposerMetadata(draft = ""): ComposerMetadata {
  return {
    localFilePaths: [],
    inputReferences: [],
    mentionReferences: { draft, bindings: [] },
    attachmentError: null,
  };
}
