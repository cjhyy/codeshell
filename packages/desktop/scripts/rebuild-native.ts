// Rebuild native modules (node-pty) against the installed Electron's ABI.
//
// Why this exists: node-pty ships no prebuilt binary for Electron, and a plain
// `bun install` leaves `build/Release/pty.node` missing — the terminal panel
// then fails to spawn a shell ("posix_spawnp failed" / instant exit). This
// runs on postinstall so the binary is always present and matched to the
// Electron version actually installed (no hardcoded version to drift).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

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
// avoid the spawn entirely when the binary is present.
const builtMarker = ptyPkg.replace(/package\.json$/, "build/Release/pty.node");
if (existsSync(builtMarker) && process.env.FORCE_REBUILD_NATIVE !== "1") {
  console.log("[rebuild-native] pty.node present; skipping (set FORCE_REBUILD_NATIVE=1 to force).");
  process.exit(0);
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
