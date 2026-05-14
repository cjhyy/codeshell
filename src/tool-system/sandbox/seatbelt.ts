/**
 * macOS Seatbelt backend.
 *
 * Builds a sandbox-exec profile that:
 *   - Allows reading most of the filesystem (denying everything breaks tooling)
 *   - Denies reads of sensitive credential directories
 *   - Restricts writes to the workspace + writableRoots
 *   - Optionally denies outbound network
 *
 * The profile is written to a fresh temp file per command (cheap; users can
 * have arbitrary writableRoots so we can't cache). The spawned process and
 * its entire subprocess tree inherit the profile via XNU's sandbox framework.
 *
 * sandbox-exec is technically deprecated by Apple but remains the only
 * working OS-level sandbox on macOS and is what Codex CLI / Cursor use today.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxBackend, SandboxConfig } from "./index.js";

export function createSeatbeltBackend(config: SandboxConfig): SandboxBackend {
  return {
    name: "seatbelt",
    wrap(command, opts) {
      const profile = buildProfile(config);
      const dir = mkdtempSync(join(tmpdir(), "codeshell-sandbox-"));
      const profilePath = join(dir, "profile.sb");
      writeFileSync(profilePath, profile, "utf-8");
      return {
        file: "/usr/bin/sandbox-exec",
        args: ["-f", profilePath, opts.shell, "-c", command],
      };
    },
    hintForBlockedOutput(stderr) {
      if (/Operation not permitted|sandbox/.test(stderr)) {
        return (
          "\n[sandbox:seatbelt] A syscall was blocked by the sandbox. " +
          "If this path should be writable or this network call legitimate, " +
          "ask the user to update sandbox.writableRoots / sandbox.network in settings.json."
        );
      }
      return undefined;
    },
  };
}

function buildProfile(config: SandboxConfig): string {
  const writeAllows = config.writableRoots
    .map((p) => `  (subpath ${quote(p)})`)
    .join("\n");
  const readDenies = config.deniedReads
    .map((p) => `  (subpath ${quote(p)})`)
    .join("\n");
  const networkClause =
    config.network === "deny" ? "(deny network-outbound)" : "(allow network*)";

  // SBPL evaluation note: when a broad `(allow file-read*)` and a specific
  // `(deny file-read* (subpath …))` both match, the more specific subpath
  // rule wins — order between the two clauses does not matter. We tested
  // this empirically (both orderings block reads of denied subpaths) and
  // the integration test in tests/sandbox.test.ts uses `cat <secret>` to
  // verify reads are actually blocked, not just `ls`. The only previously
  // observed leak was when the denied path was given as `/tmp/...` while
  // `/tmp` symlinks to `/private/tmp`; sandbox-exec matches subpaths on
  // canonical paths, so `expandConfig()` runs `realpathSync` up front.
  return `(version 1)
(deny default)

;; Process control
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow signal (target children))

;; Reads: broadly allowed, then explicit deny of sensitive paths
(allow file-read*)
${readDenies ? `(deny file-read*\n${readDenies})` : ""}

;; Writes: workspace + listed roots only
(allow file-write*
${writeAllows})
(allow file-write-data
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/dtracehelper"))

;; IPC & system services common tools need
(allow mach-lookup)
(allow ipc-posix-shm)
(allow sysctl-read)
(allow system-socket)
(allow iokit-open)

;; Network
${networkClause}
`;
}

function quote(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}
