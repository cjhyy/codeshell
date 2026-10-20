import type { SessionWorkspaceWorktreeInfo } from "../../preload/types";

type WorkspaceDiff = NonNullable<SessionWorkspaceWorktreeInfo["diff"]>;

export type WorkspaceDiffState = {
  diff?: WorkspaceDiff;
  status: "idle" | "checking" | "ready" | "error";
};

interface Entry {
  head: string;
  branch: string;
  isMain?: boolean;
  revision: number;
  expiresAt: number | null;
  state: WorkspaceDiffState;
}

interface Request {
  entry: Entry;
  revision: number;
}

const CACHE_TTL_MS = 30_000;
const MAX_CONCURRENT = 2;

/** One authority's visible worktree summaries, with bounded background work. */
export class WorkspaceDiffLoader {
  private entries = new Map<string, Entry>();
  private visible = new Set<string>();
  private inFlight = new Map<string, Request>();
  private open = false;
  private disposed = false;
  private pumping = false;

  constructor(
    private readonly load: (path: string) => Promise<WorkspaceDiff>,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  setRows(rows: SessionWorkspaceWorktreeInfo[]): void {
    if (this.disposed) return;
    const previousMain = [...this.entries].find(([, entry]) => entry.isMain);
    const main = rows.find((row) => row.isMain);
    const baseChanged =
      previousMain !== undefined &&
      main !== undefined &&
      (previousMain[0] !== main.path ||
        previousMain[1].head !== main.head ||
        previousMain[1].branch !== main.branch);
    const next = new Map<string, Entry>();
    let changed = false;
    for (const row of rows) {
      const previous = this.entries.get(row.path);
      if (
        previous?.head === row.head &&
        previous.branch === row.branch &&
        previous.isMain === row.isMain
      ) {
        next.set(row.path, previous);
      } else {
        next.set(row.path, {
          head: row.head,
          branch: row.branch,
          isMain: row.isMain,
          revision: 0,
          expiresAt: row.diff ? this.now() + CACHE_TTL_MS : null,
          state: { diff: row.diff, status: row.diff ? "ready" : "idle" },
        });
        changed = true;
      }
    }
    for (const path of this.entries.keys()) {
      if (!next.has(path)) {
        this.visible.delete(path);
        changed = true;
      }
    }
    this.entries = next;
    if (baseChanged) changed = this.invalidateEntries() || changed;
    this.notify(this.pump() || changed);
  }

  setOpen(open: boolean): void {
    if (this.disposed) return;
    this.open = open;
    this.notify(this.pump());
  }

  setVisible(path: string, visible: boolean): void {
    if (this.disposed) return;
    if (visible) this.visible.add(path);
    else this.visible.delete(path);
    this.notify(this.pump());
  }

  getState(row: SessionWorkspaceWorktreeInfo): WorkspaceDiffState {
    const entry = this.entries.get(row.path);
    if (entry?.head === row.head && entry.branch === row.branch) return entry.state;
    return { diff: row.diff, status: row.diff ? "ready" : "idle" };
  }

  invalidate(): void {
    if (this.disposed) return;
    const changed = this.invalidateEntries();
    this.notify(this.pump() || changed);
  }

  private invalidateEntries(): boolean {
    for (const entry of this.entries.values()) {
      entry.revision += 1;
      entry.expiresAt = null;
      entry.state = {
        diff: entry.state.diff,
        status: entry.state.diff ? "ready" : "idle",
      };
    }
    return this.entries.size > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.open = false;
    this.entries.clear();
    this.visible.clear();
    this.inFlight.clear();
  }

  private notify(changed: boolean): void {
    if (changed && !this.disposed) this.onChange();
  }

  private pump(): boolean {
    if (this.disposed || !this.open || this.pumping) return false;
    let changed = false;
    this.pumping = true;
    try {
      // Pending work is derived from current visibility, so closing the menu or
      // scrolling a row away discards it before another slot becomes available.
      for (const [path, entry] of this.entries) {
        if (this.disposed || !this.open || this.inFlight.size >= MAX_CONCURRENT) break;
        if (!this.visible.has(path) || this.inFlight.has(path)) continue;
        if (entry.expiresAt !== null && entry.expiresAt > this.now()) continue;
        const request = { entry, revision: entry.revision };
        this.inFlight.set(path, request);
        entry.state = { diff: entry.state.diff, status: "checking" };
        changed = true;
        let result: Promise<WorkspaceDiff>;
        try {
          result = this.load(path);
        } catch {
          result = Promise.reject();
        }
        void Promise.resolve(result).then(
          (diff) => this.finish(path, request, diff),
          () => this.finish(path, request),
        );
      }
    } finally {
      this.pumping = false;
    }
    return changed;
  }

  private finish(path: string, request: Request, diff?: WorkspaceDiff): void {
    if (this.disposed || this.inFlight.get(path) !== request) return;
    this.inFlight.delete(path);
    const entry = this.entries.get(path);
    const current = entry === request.entry && entry.revision === request.revision;
    if (current) {
      entry.state = {
        diff: diff ?? entry.state.diff,
        status: diff ? "ready" : "error",
      };
      // Failures also receive a cooldown: a failed request must not immediately
      // become eligible again when completion drains the visible rows.
      entry.expiresAt = this.now() + CACHE_TTL_MS;
    }
    // Entry identity and revision reject completions from removed rows, changed
    // HEADs, and invalidations. A replacement request waits for this path's slot.
    this.notify(this.pump() || current);
  }
}
