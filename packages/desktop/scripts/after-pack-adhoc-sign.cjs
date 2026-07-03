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
// FIX:
//   1. Run a deep ad-hoc codesign (`codesign --deep --force -s -`) so nested
//      frameworks/helpers and bundle resources are sealed.
//   2. Re-sign ONLY the outer .app with a stable custom designated requirement:
//      `identifier "com.cjhyy.codeshell"`.
//
// Plain ad-hoc signing gives the app a cdhash-based requirement. Squirrel.Mac
// uses the installed app's requirement to validate the downloaded update, so
// any content change changes the cdhash and makes "Restart and install" fail.
// A stable outer requirement lets ad-hoc builds update other ad-hoc builds that
// were installed with this same requirement. This is still NOT Developer ID
// signing/notarization; the first install from older cdhash-only builds remains
// manual, and Developer ID is the proper long-term fix.
//
// No-op on non-macOS. Best-effort: a signing failure logs but does not abort
// the build (an unsigned build is still better than no build).

/* global require, exports */

const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const APP_ID = "com.cjhyy.codeshell";
const STABLE_REQUIREMENT = `designated => identifier "${APP_ID}"`;
const VERIFY_REQUIREMENT = `identifier "${APP_ID}"`;

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
    // Re-sign only the outer app. Applying this requirement with --deep would
    // also force it onto nested Electron frameworks and break deep verification.
    execFileSync("codesign", ["--force", "-s", "-", `-r=${STABLE_REQUIREMENT}`, appPath], {
      stdio: "inherit",
    });
    // Verify the seal actually covers resources now; log (don't throw) on drift.
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "inherit",
    });
    execFileSync("codesign", ["--verify", `-R=${VERIFY_REQUIREMENT}`, appPath], {
      stdio: "inherit",
    });
    // eslint-disable-next-line no-console
    console.log(`[afterPack] ad-hoc signed ${appName} with stable requirement: ${STABLE_REQUIREMENT}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[afterPack] ad-hoc sign failed (shipping unsigned): ${err}`);
  }
};
