/** Expand only from an observed process incarnation that is still alive. */
export function rememberOwnedProcesses(owned, current) {
  const ids = new Set(
    current.filter((item) => owned.get(item.pid)?.birth === item.birth).map((item) => item.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of current) {
      if (!ids.has(item.ppid) || ids.has(item.pid)) continue;
      const previous = owned.get(item.pid);
      // A PID can be reused after the original process died. Never re-authorize
      // that new incarnation or discover its children through the stale PID.
      if (previous && previous.birth !== item.birth) continue;
      owned.set(item.pid, item);
      ids.add(item.pid);
      changed = true;
    }
  }
}
