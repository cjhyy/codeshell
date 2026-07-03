// electron-builder afterPack hook: ad-hoc sign the whole .app on macOS.
//
// WHY: We ship UNSIGNED (no Apple Developer ID). When electron-builder finds no
// signing identity it *skips* signing the app bundle entirely — only the
// Electron framework binaries keep their linker ad-hoc signature. The result is
// a bundle whose seal doesn't cover its resources: `spctl` reports
//   "code has no resources but signature indicates they must be present"
// and macOS shows the dreaded **"App is damaged and can't be opened"** (worse
// than the normal "unidentified developer" prompt — right-click-open often
// can't get past "damaged"). This is exactly what beta testers hit downloading
// the .dmg from GitHub Releases.
//
// FIX: after electron-builder packs the .app, run a deep ad-hoc codesign
// (`codesign --deep --force -s -`). That re-seals ALL resources (verified:
// `Sealed Resources version=2 rules=13 files=…`, and `codesign --verify --deep
// --strict` passes). Gatekeeper then downgrades the verdict from "damaged" to
// the ordinary "unidentified developer" — which right-click → Open clears.
// This is NOT notarization (still needs an Apple account for that), just the
// cheapest thing that stops the "damaged" false alarm.
//
// No-op on non-macOS. Best-effort: a signing failure logs but does not abort
// the build (an unsigned build is still better than no build).

/* global require, exports */

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);

  try {
    // --deep: recurse into nested bundles/frameworks/helpers.
    // --force: replace the incomplete linker signature.
    // -s -  : ad-hoc identity (no certificate).
    execFileSync("codesign", ["--deep", "--force", "-s", "-", appPath], {
      stdio: "inherit",
    });
    // Verify the seal actually covers resources now; log (don't throw) on drift.
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "inherit",
    });
    // eslint-disable-next-line no-console
    console.log(`[afterPack] ad-hoc signed ${appName}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[afterPack] ad-hoc sign failed (shipping unsigned): ${err}`);
  }
};
