import type { SessionIndex } from "@cjhyy/code-shell-server/storage";
import { isDesktopSessionId, type ListSessionOptions } from "../../shared/disk-session-query.js";

/** A deletion can start and finish while a WAL reader still holds an older
 * snapshot. Each open read remembers those ids until its own reply is sent. */
export class DesktopSessionListVisibility {
  private readonly deleting = new Map<string, object>();
  private readonly pending = new Set<Set<string>>();

  constructor(private readonly index: Pick<SessionIndex, "list" | "changed">) {}

  list(options: ListSessionOptions) {
    return this.visibleRead(async (hidden) => {
      const page = await this.index.list(options);
      return hidden.size
        ? { ...page, sessions: page.sessions.filter((row) => !hidden.has(row.engineSessionId)) }
        : page;
    });
  }

  history(read: SessionIndex["history"]) {
    return this.visibleRead(async (hidden) => {
      const rows = await read();
      return hidden.size ? rows.filter((row) => !hidden.has(row.id)) : rows;
    });
  }

  private async visibleRead<T>(read: (hidden: ReadonlySet<string>) => Promise<T>) {
    const hidden = new Set(this.deleting.keys());
    this.pending.add(hidden);
    try {
      return await read(hidden);
    } finally {
      this.pending.delete(hidden);
    }
  }

  setDeleting(id: string, deleting: boolean): void {
    if (!isDesktopSessionId(id)) return;
    if (deleting) {
      this.deleting.set(id, {});
      for (const hidden of this.pending) hidden.add(id);
      return;
    }
    const generation = this.deleting.get(id);
    if (!generation) return;
    // The index switches to its JSON reader if a reconciliation cannot use SQLite.
    void this.index
      .changed(id)
      .then(() => {
        if (this.deleting.get(id) === generation) this.deleting.delete(id);
      })
      .catch(() => {
        /* Remain hidden if visibility has not been established. */
      });
  }
}
