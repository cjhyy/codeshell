/**
 * Linux bubblewrap backend.
 *
 * bwrap creates a fresh mount namespace, then bind-mounts only what we tell
 * it. We bind / read-only and overlay writableRoots as read-write. PID,
 * IPC, UTS, cgroup namespaces are unshared. Network is shared unless
 * config.network === "deny".
 *
 * Sensitive directories listed in deniedReads are shadowed with a tmpfs so
 * the inner process literally cannot see them even though `/` is mounted.
 */

import type { SandboxBackend, SandboxConfig } from "./index.js";

export function createBwrapBackend(config: SandboxConfig): SandboxBackend {
  return {
    name: "bwrap",
    wrap(command, opts) {
      const args: string[] = [];

      args.push("--ro-bind", "/", "/");
      args.push("--dev", "/dev");
      args.push("--proc", "/proc");
      args.push("--tmpfs", "/tmp");

      for (const root of config.writableRoots) {
        args.push("--bind-try", root, root);
      }
      // Shadow each denied path by bind-mounting /dev/null on top. Why this
      // approach instead of `--tmpfs <denied>`:
      //   1. `--tmpfs` requires the destination to exist (mount(2) does), so
      //      a missing ~/.aws meant we had to skip the deny entirely — that's
      //      a TOCTOU window: if the host creates ~/.aws between wrap-time
      //      and spawn-time (or while the child is alive, since --ro-bind /
      //      reflects live host state, not a snapshot), the shadow never
      //      applies.
      //   2. `--ro-bind-try /dev/null DEST` is no-op when DEST is missing on
      //      the host (SRC is always there); when DEST exists, the bind hides
      //      whatever was there. A read of the path returns EOF; directory
      //      traversal fails (it's a char device, not a dir).
      // The leftover case — DEST didn't exist at wrap-time, then appears on
      // the host mid-run — is mitigated by `--ro-bind / /` making the rest of
      // the filesystem read-only inside the sandbox, so the child can't
      // create the path itself. A host-side concurrent write into a denied
      // path is still visible to the sandbox; document that limitation in
      // index.ts rather than papering over it here.
      for (const denied of config.deniedReads) {
        args.push("--ro-bind-try", "/dev/null", denied);
      }

      args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup");
      if (config.network === "deny") {
        args.push("--unshare-net");
      }

      args.push("--die-with-parent");
      args.push("--chdir", opts.cwd);

      args.push(opts.shell, "-c", command);

      return { file: "bwrap", args };
    },
    hintForBlockedOutput(stderr) {
      if (/Permission denied|No such file or directory.*bwrap/i.test(stderr)) {
        return (
          "\n[sandbox:bwrap] A path access was blocked by the sandbox. " +
          "If this path should be writable, ask the user to update " +
          "sandbox.writableRoots in settings.json."
        );
      }
      return undefined;
    },
  };
}
