import { runtimePathFlag } from "../shared/desktop-host-protocol.js";

/** Main settles the executable PATH of its utility. Standalone consumers inherit their launch environment. */
export function createRuntimePath(wait: boolean, env: NodeJS.ProcessEnv = process.env) {
  const gate = Promise.withResolvers<void>();
  let pending = wait;
  if (!wait) gate.resolve();
  return {
    ready: gate.promise,
    whenReady(start: () => void) {
      if (pending) void gate.promise.then(start);
      else start();
    },
    searchPath(fallback?: string) {
      return wait ? (env.PATH ?? "") : fallback;
    },
    install(path: string) {
      if (!pending) return;
      pending = false;
      env.PATH = path;
      gate.resolve();
    },
  };
}

export const hostRuntimePath = createRuntimePath(process.argv.includes(runtimePathFlag));
