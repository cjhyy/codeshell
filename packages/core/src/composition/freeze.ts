/** Copy declarations before freezing: compiling must never freeze an author's input. */
export function freezeDeclarations<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Set || value instanceof Map) {
    const copy = value instanceof Set ? new Set() : new Map();
    const readonly = new Proxy(copy, {
      get(target, key) {
        if (key === "valueOf") return () => readonly;
        if (key === "forEach")
          return (callback: (...args: unknown[]) => void, thisArg?: unknown) => {
            target.forEach((item, itemKey) => callback.call(thisArg, item, itemKey, readonly));
          };
        if (["add", "set", "delete", "clear"].includes(String(key))) {
          return () => {
            throw new TypeError("Composition declarations are immutable");
          };
        }
        const result = Reflect.get(target, key, target);
        return typeof result === "function" ? result.bind(target) : result;
      },
    });
    seen.set(value, readonly);
    if (value instanceof Set) {
      for (const item of value) (copy as Set<unknown>).add(freezeDeclarations(item, seen));
    } else {
      for (const [key, item] of value)
        (copy as Map<unknown, unknown>).set(
          freezeDeclarations(key, seen),
          freezeDeclarations(item, seen),
        );
    }
    return Object.freeze(readonly) as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return value;
  const copy: any = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = freezeDeclarations(item, seen);
  return Object.freeze(copy);
}
