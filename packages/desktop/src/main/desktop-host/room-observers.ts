type ResumeRead = (resume: boolean, signal: AbortSignal) => Promise<unknown>;
interface Watch {
  room: string;
  key: string;
  read: ResumeRead;
  active: AbortController;
  confirmed: boolean;
}
/** Native keeps only a view's read request. The replacement Host must prove
 * the project/delegation, room tuple and checkpoint again before watching. */
export class RoomObservers {
  private readonly views = new Map<string, Map<string, Watch>>();
  async subscribe(key: string, room: string, read: ResumeRead) {
    this.remove(key, room);
    const watches = this.views.get(key) ?? new Map<string, Watch>();
    this.views.set(key, watches);
    const item = { key, room, read, active: new AbortController(), confirmed: false };
    watches.set(room, item);
    try {
      const value = await read(false, item.active.signal);
      item.active.signal.throwIfAborted();
      if (value === false) this.remove(key, room);
      else item.confirmed = true;
      return value;
    } catch (error) {
      if (watches.get(room) === item) this.remove(key, room);
      throw error;
    }
  }
  remove(key: string, room?: string) {
    const watches = this.views.get(key);
    if (!watches) return;
    if (room === undefined) {
      for (const item of watches.values()) item.active.abort();
      watches.clear();
    } else {
      watches.get(room)?.active.abort();
      watches.delete(room);
    }
    if (!watches.size) this.views.delete(key);
  }
  ended(room: string) {
    for (const key of this.views.keys()) this.remove(key, room);
  }
  pause() {
    for (const watches of this.views.values())
      for (const item of watches.values()) item.active.abort();
  }
  async resume(failed: (room: string) => void) {
    const work: Promise<void>[] = [];
    for (const watches of this.views.values())
      for (const item of watches.values()) {
        if (!item.confirmed) continue;
        const active = new AbortController();
        item.active = active;
        work.push(
          item
            .read(true, active.signal)
            .then((ok) => {
              if (ok === false) throw Error("Room observation unavailable");
            })
            .catch(() => {
              if (active.signal.aborted || watches.get(item.room) !== item) return;
              this.remove(item.key, item.room);
              failed(item.room);
            }),
        );
      }
    await Promise.all(work);
  }
}
