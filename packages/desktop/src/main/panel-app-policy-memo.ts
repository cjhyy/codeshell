/**
 * Short-lived memo for the synchronous Panel App binding guard.
 *
 * The guard rebuilds a SettingsManager (synchronous reads and validation of
 * the user and project settings) and runs on the Electron main thread for
 * every bridge call and every resource-copy chunk. A task copying a 1 GB
 * input used to repeat it tens of thousands of times. In-process binding
 * writes invalidate the memo; out-of-process edits take effect within the
 * window, which stays below the 1 s authorization poll of running tool tasks.
 */
export function createPanelAppPolicyMemo<T>(
  read: (cwd: string) => T,
  options: { ttlMs: number; maxEntries: number; now?: () => number },
) {
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, { value: T; at: number }>();
  return {
    get(cwd: string): T {
      const cached = entries.get(cwd);
      const at = now();
      if (cached && at - cached.at < options.ttlMs) return cached.value;
      entries.delete(cwd);
      const value = read(cwd);
      if (entries.size >= options.maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(cwd, { value, at });
      return value;
    },
    invalidate() {
      entries.clear();
    },
  };
}
