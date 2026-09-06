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

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxBackend, SandboxConfig } from "./index.js";

/**
 * Per-user MDS (Module Directory Service) scratch directory.
 *
 * Security.framework opens the keychain through MDS, which needs to write a
 * lock file under the per-user Darwin cache dir. Without it *any* keychain
 * read fails — see the `(allow file-write* …/mds)` clause in buildProfile()
 * for why that matters and how it presents.
 *
 * `getconf DARWIN_USER_CACHE_DIR` reports the `/var/folders/…` form, but
 * Seatbelt matches subpaths canonically (`/private/var/folders/…`), so the
 * result is realpath'd — the same footgun expandConfig() handles for
 * writableRoots. Resolved once per process; the value is stable for a user.
 */
let mdsCacheDir: string | null | undefined;
function resolveMdsCacheDir(): string | null {
  if (mdsCacheDir !== undefined) return mdsCacheDir;
  try {
    const cacheDir = execFileSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    // Bail rather than emit a bogus rule if getconf returns something odd.
    mdsCacheDir = cacheDir ? realpathSync(join(cacheDir, "mds")) : null;
  } catch {
    // getconf missing/failed, or no mds dir yet on this host. Keychain reads
    // stay broken, but that's strictly the pre-existing behavior — never fail
    // the whole sandbox over it.
    mdsCacheDir = null;
  }
  return mdsCacheDir;
}

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
        cleanup: () => {
          // sandbox-exec has already exited (this runs from Bash tool's
          // child `close` handler), so removing the profile file is safe.
          // force=true swallows ENOENT in case the dir was already cleaned
          // up out-of-band (e.g. system tmpwatch).
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best-effort. A leftover dir is recoverable; throwing here
            // would mask the actual command output we just sent back.
          }
        },
      };
    },
    hintForBlockedOutput(stderr) {
      // Keychain denials never say "sandbox" or "Operation not permitted" —
      // they surface as an MDS error, or as a downstream tool blaming its own
      // credentials ("token invalid") after silently falling back off the
      // keyring. Match the MDS string specifically so the model stops
      // recommending a re-login for what is a sandbox problem. This is a
      // deterministic error string from Security.framework, not prose.
      if (/Module Directory Service error/.test(stderr)) {
        return (
          "\n[sandbox:seatbelt] A keychain read failed inside the sandbox " +
          "(Security.framework/MDS). Any 'invalid token' / 'not logged in' " +
          "message above is likely bogus — the credential is in the macOS " +
          "keychain and was unreadable, NOT wrong. Do not re-run `auth login`. " +
          "If this host has an unusual DARWIN_USER_CACHE_DIR, ask the user to " +
          "add its `mds` dir to sandbox.writableRoots in settings.json."
        );
      }
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
  const writeAllows = config.writableRoots.map((p) => `  (subpath ${quote(p)})`).join("\n");
  const readDenies = config.deniedReads.map((p) => `  (subpath ${quote(p)})`).join("\n");
  const networkClause = config.network === "deny" ? "(deny network-outbound)" : "(allow network*)";

  // Keychain access. Tools that store credentials in the macOS keychain
  // (`gh`, `az`, `docker login`, anything calling /usr/bin/security) shell
  // out to Security.framework, which reaches the keychain via MDS — and MDS
  // needs to write a lock file under the per-user Darwin cache dir. That dir
  // is outside the workspace, so a write-restricted profile blocks it.
  //
  // The failure is worth spelling out because it does NOT look like a
  // sandbox denial: `security` exits 44 with "A Module Directory Service
  // error has occurred", and callers treat that as "no keychain" and fall
  // back to their plaintext config. `gh` then reports "The token in default
  // is invalid" — pointing at the token, which is fine, instead of at the
  // sandbox. Users burn a lot of time re-running `gh auth login` here.
  //
  // Verified empirically: this single clause is the minimal delta that makes
  // `gh auth status` report `(keyring)` instead of `(default)` under an
  // otherwise unchanged profile. Reads of ~/.ssh and writes outside the
  // workspace stay denied — the grant is one scratch dir, not a hole.
  const mdsDir = resolveMdsCacheDir();
  const keychainClause = mdsDir
    ? `\n;; Keychain (Security.framework/MDS scratch)\n(allow file-write* (subpath ${quote(mdsDir)}))\n`
    : "";

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
${keychainClause}
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
