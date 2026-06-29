// Rebuild native modules (node-pty) against the installed Electron's ABI.
//
// Why this exists: node-pty ships no prebuilt binary for Electron, and a plain
// `bun install` leaves `build/Release/pty.node` missing — the terminal panel
// then fails to spawn a shell ("posix_spawnp failed" / instant exit). This
// runs on postinstall so the binary is always present and matched to the
// Electron version actually installed (no hardcoded version to drift).
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/**
 * Read a Mach-O binary's CPU architecture from its header (no `file` dep, so
 * this works the same in any shell/CI). Returns "arm64" | "x86_64" | null.
 *
 * Why we need this: a stale `pty.node` built for the *other* arch still
 * "exists", so an existence check alone skips the rebuild and the terminal
 * panel dies with "posix_spawnp failed". The classic trigger is a dual-arch
 * `electron-builder dist` (arm64 + x86_64): each arch rebuilds the shared
 * node_modules binary, and whichever runs last wins — often x86_64, which
 * then poisons arm64 dev. So we compare arch, not mere presence.
 */
function machoArch(file: string): "arm64" | "x86_64" | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8);
    if (readSync(fd, buf, 0, 8, 0) < 8) return null;
    const magic = buf.readUInt32BE(0);
    // Mach-O 64-bit: MH_MAGIC_64 (0xfeedfacf) little- or big-endian; cputype
    // is the next 4 bytes. CPU_TYPE_X86_64 = 0x01000007, CPU_TYPE_ARM64 = 0x0100000c.
    let cpuType: number;
    if (magic === 0xfeedfacf) cpuType = buf.readUInt32BE(4); // big-endian header
    else if (magic === 0xcffaedfe) cpuType = buf.readUInt32LE(4); // little-endian header
    else return null; // not a 64-bit Mach-O (fat/thin 32-bit etc.) — treat as unknown
    if (cpuType === 0x0100000c) return "arm64";
    if (cpuType === 0x01000007) return "x86_64";
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** node's process.arch → Mach-O arch name. */
function hostMachoArch(): "arm64" | "x86_64" | null {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  return null;
}

// Skip if node-pty isn't installed yet (e.g. partial install) — nothing to do.
const ptyPkg = (() => {
  try {
    return require.resolve("node-pty/package.json");
  } catch {
    return null;
  }
})();
if (!ptyPkg) {
  console.log("[rebuild-native] node-pty not installed; skipping.");
  process.exit(0);
}

// Resolve the installed Electron version so the ABI matches exactly.
let electronVersion: string;
try {
  electronVersion = (require("electron/package.json") as { version: string }).version;
} catch {
  console.log("[rebuild-native] electron not installed; skipping native rebuild.");
  process.exit(0);
}

// Already built for this Electron? `@electron/rebuild` is fast to no-op, but we
// avoid the spawn entirely when the binary is present AND matches the host arch.
// On macOS we additionally verify the Mach-O arch: a stale binary from a
// dual-arch `electron-builder dist` (which rewrites the shared node_modules
// binary) "exists" but can be the wrong arch → "posix_spawnp failed". Presence
// alone is not enough; arch must match or we rebuild even without FORCE.
const builtMarker = ptyPkg.replace(/package\.json$/, "build/Release/pty.node");
const force = process.env.FORCE_REBUILD_NATIVE === "1";
if (existsSync(builtMarker) && !force) {
  if (process.platform === "darwin") {
    const host = hostMachoArch();
    const got = machoArch(builtMarker);
    if (host && got && host !== got) {
      console.log(
        `[rebuild-native] pty.node is ${got} but host is ${host} — rebuilding ` +
          "(likely poisoned by a dual-arch dist build).",
      );
      // fall through to rebuild
    } else {
      console.log(
        `[rebuild-native] pty.node present (${got ?? "arch?"}, host ${host ?? "arch?"}); ` +
          "skipping (set FORCE_REBUILD_NATIVE=1 to force).",
      );
      process.exit(0);
    }
  } else {
    console.log("[rebuild-native] pty.node present; skipping (set FORCE_REBUILD_NATIVE=1 to force).");
    process.exit(0);
  }
}

console.log(`[rebuild-native] rebuilding node-pty for Electron ${electronVersion}…`);
const res = spawnSync(
  "bunx",
  ["--bun", "@electron/rebuild", "-v", electronVersion, "-f", "-w", "node-pty"],
  { stdio: "inherit" },
);
// Never fail `bun install` over this: as a postinstall hook, a non-zero exit
// would abort the whole workspace install. If the rebuild fails, warn loudly
// (the terminal panel won't work until it's rebuilt) but exit cleanly.
if (res.status !== 0) {
  console.warn(
    "[rebuild-native] node-pty rebuild failed — the terminal panel won't work " +
      "until you run `bun run rebuild:native` in packages/desktop.",
  );
}
process.exit(0);
