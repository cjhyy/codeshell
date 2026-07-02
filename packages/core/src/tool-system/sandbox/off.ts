import type { SandboxBackend } from "./index.js";
import { resolveShellInvocation } from "../../runtime/spawn-common.js";

export function createOffBackend(): SandboxBackend {
  return {
    name: "off",
    wrap(command, opts) {
      // "off" = no sandboxing; just run the command through the shell. Delegate
      // to resolveShellInvocation for the PLATFORM-CORRECT flag instead of a
      // hardcoded POSIX `-c`: on Windows cmd.exe needs `/c` (a bare `-c` is taken
      // as a filename and cmd hangs in interactive mode until timeout — the
      // "Bash never runs on Windows" beta regression). POSIX still gets `-c`.
      return resolveShellInvocation(command, opts.shell);
    },
  };
}
