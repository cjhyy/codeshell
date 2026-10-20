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
  private readonly settled = new WeakSet<SubmittedDraft>();

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

  /**
   * Put a submission that was not delivered back into its session's composer,
   * at most once. "restored" means the composer now holds exactly that
   * submission. When the user kept typing meanwhile, nothing they wrote is
   * overwritten: the failed text and attachments are placed before it and the
   * result is "merged". The failed submission is never dropped, because it
   * may be the only copy of the task.
   */
  restore(submitted: SubmittedDraft): "restored" | "merged" | false {
    if (this.settled.has(submitted)) return false;
    this.settled.add(submitted);
    const current = this.get(submitted.sessionId);
    const { draft } = submitted;
    if (!current.text && !current.files.length) {
      this.update(submitted.sessionId, { text: draft.text, files: draft.files });
      return "restored";
    }
    const restoredIds = new Set(draft.files.map((file) => file.id));
    this.update(submitted.sessionId, {
      text: !draft.text
        ? current.text
        : !current.text
          ? draft.text
          : `${draft.text}\n\n${current.text}`,
      files: [...draft.files, ...current.files.filter((file) => !restoredIds.has(file.id))],
    });
    return "merged";
  }

  unsent(): Array<{ sessionId: string; draft: ComposerDraft }> {
    return [...this.drafts].flatMap(([sessionId, draft]) =>
      draft.text.trim() || draft.files.length ? [{ sessionId, draft }] : [],
    );
  }
}
