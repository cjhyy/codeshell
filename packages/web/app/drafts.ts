import type { UploadedFile } from "./auth.js";

export interface ComposerDraft {
  text: string;
  files: UploadedFile[];
  revision: number;
}

export interface SubmittedDraft {
  sessionId: string;
  draft: ComposerDraft;
  clearedRevision: number;
}

/** In-memory only: task drafts and authenticated upload IDs never enter
 * localStorage. Every edit advances a per-session revision, including edits
 * which return to an empty value, so a late failure cannot undo user intent. */
export class SessionDrafts {
  private readonly drafts = new Map<string, ComposerDraft>();

  get(sessionId: string): ComposerDraft {
    return this.drafts.get(sessionId) ?? { text: "", files: [], revision: 0 };
  }

  private update(sessionId: string, next: Omit<ComposerDraft, "revision">): ComposerDraft {
    const value = { ...next, revision: this.get(sessionId).revision + 1 };
    this.drafts.set(sessionId, value);
    return value;
  }

  setText(sessionId: string, text: string): ComposerDraft {
    return this.update(sessionId, { ...this.get(sessionId), text });
  }

  addFile(sessionId: string, file: UploadedFile): ComposerDraft {
    const current = this.get(sessionId);
    return this.update(sessionId, { ...current, files: [...current.files, file] });
  }

  removeFile(sessionId: string, fileId: string): ComposerDraft {
    const current = this.get(sessionId);
    return this.update(sessionId, {
      ...current,
      files: current.files.filter((file) => file.id !== fileId),
    });
  }

  take(sessionId: string): SubmittedDraft {
    const draft = this.get(sessionId);
    const cleared = this.update(sessionId, { text: "", files: [] });
    return { sessionId, draft, clearedRevision: cleared.revision };
  }

  restore(submitted: SubmittedDraft): boolean {
    const current = this.get(submitted.sessionId);
    if (current.revision !== submitted.clearedRevision || current.text || current.files.length)
      return false;
    this.update(submitted.sessionId, submitted.draft);
    return true;
  }

  unsent(): Array<{ sessionId: string; draft: ComposerDraft }> {
    return [...this.drafts].flatMap(([sessionId, draft]) =>
      draft.text.trim() || draft.files.length ? [{ sessionId, draft }] : [],
    );
  }
}
