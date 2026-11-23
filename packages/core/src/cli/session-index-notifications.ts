import { channel } from "node:diagnostics_channel";
import { resolve } from "node:path";

/** Only the Desktop-owned stdio worker opts into this metadata notification. */
export function observeSessionIndexWrites(
  root: string,
  notify: (ids: string[]) => void,
): () => void {
  const ownedRoot = resolve(root);
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const committed = channel("codeshell.session.state-committed");
  const observe = (message: unknown) => {
    const record = message as { root?: string; id?: string } | null;
    if (!record || record.root !== ownedRoot || typeof record.id !== "string") return;
    // Periodic reconciliation covers overflow. Keep an output-heavy worker's
    // notification traffic and memory independent of its token event count.
    if (dirty.size < 512) dirty.add(record.id);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const ids = [...dirty];
      dirty.clear();
      notify(ids);
    }, 200);
    timer.unref();
  };
  committed.subscribe(observe);
  return () => {
    committed.unsubscribe(observe);
    if (timer) clearTimeout(timer);
    dirty.clear();
  };
}
