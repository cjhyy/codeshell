// The composer reads both stores for every configuration target. Keep one
// in-flight or recent successful result per store in this window. Settings
// notifications replace the readers, including any requests still in flight.
export function recentRead<T>(load: () => Promise<T>): () => Promise<T> {
  let entry: { promise: Promise<T>; expires: number } | undefined;
  return () => {
    if (entry && Date.now() < entry.expires) return entry.promise;
    const promise = load().then(
      (value) => {
        if (entry?.promise === promise) entry.expires = Date.now() + 60_000;
        return value;
      },
      (error) => {
        if (entry?.promise === promise) entry = undefined;
        throw error;
      },
    );
    entry = { promise, expires: Infinity };
    return promise;
  };
}
