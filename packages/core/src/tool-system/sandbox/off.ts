import type { SandboxBackend } from "./index.js";
import { resolveShellInvocation } from "../../runtime/spawn-common.js";

export function createOffBackend(): SandboxBackend {
  return {
    name: "off",
    wrap(command, opts) {
      // Platform-aware flag: cmd.exe takes /c, PowerShell -Command, POSIX -c.
      // Bash always passes a backend (off at minimum), so resolveSpawnTarget's
      // no-sandbox fallback never covers this path — wrap() must handle it.
      return resolveShellInvocation(command, opts.shell);
    },
  };
}
