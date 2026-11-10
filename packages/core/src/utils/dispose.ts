export type Dispose = () => void | Promise<void>;

/** Bind deletion to one registration, and never execute the same disposer twice. */
export function onceDispose(dispose: Dispose): Dispose {
  let called = false;
  let result: void | Promise<void>;
  return () => {
    if (!called) {
      called = true;
      result = dispose();
    }
    return result;
  };
}
