import type { SandboxBackend } from "./index.js";

export function createOffBackend(): SandboxBackend {
  return {
    name: "off",
    wrap(command, opts) {
      return { file: opts.shell, args: ["-c", command] };
    },
  };
}
