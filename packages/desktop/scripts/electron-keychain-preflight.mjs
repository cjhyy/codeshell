import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  bindPrivateKeychainContext,
  keychainPreferenceXml,
  readDefaultKeychain,
  readKeychainReference,
} from "./macos-keychain-context.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sameFile = (a, b) =>
  a.home === b.home && a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const stages = Object.freeze({
  "fixture-home": "validating the private fixture HOME",
  "pinned-reference": "validating the pinned Keychain metadata reference",
  "account-before": "verifying the account's existing default login Keychain",
  "private-preference": "verifying the private Keychain metadata without overwriting preferences",
  private: "verifying the private default login Keychain",
  "account-after": "rechecking the account's existing default login Keychain",
  "bind-private-context": "binding the private HOME to the existing default login Keychain",
  "pin-reference": "pinning the verified private Keychain metadata",
});
const diagnostics = new WeakMap();
const identityMatches = (a, b) =>
  Object.freeze({
    sameHome: a.home === b.home,
    samePath: a.path === b.path,
    sameDevice: a.dev === b.dev,
    sameInode: a.ino === b.ino,
    sameOwner: a.uid === b.uid,
  });

/** Only locally produced, frozen enum/boolean diagnostics may cross a suite's log boundary. */
export function getElectronKeychainPreflightDiagnostic(error) {
  return diagnostics.get(error) ?? null;
}

function existing(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPrivateDirectory(path, info = lstatSync(path)) {
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw new Error("Fixture directories must be real, owned, and mode 0700");
}

function assertPrivateFile(info, limit) {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600 ||
    info.nlink !== 1 ||
    info.size > limit
  )
    throw new Error("Fixture metadata must be a bounded owned mode 0600 regular file");
}

function readReference(path) {
  if (realpathSync(path) !== resolve(path))
    throw new Error("Keychain metadata references cannot traverse symlinks");
  assertPrivateFile(lstatSync(path), 4_096);
  return readKeychainReference(path);
}

function verifyPreference(file, expected) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPrivateFile(fstatSync(descriptor), 1_024);
    if (readFileSync(descriptor, "utf8") !== expected)
      throw new Error(
        "Existing fixture Keychain preferences are not the canonical metadata reference",
      );
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Metadata-only preflight for a real Electron Keychain in an isolated HOME.
 * Never creates/unlocks a Keychain, reads an item, or changes the account's defaults.
 */
export function ensureElectronKeychainContext({
  home,
  environment = process.env,
  platform = process.platform,
  operatorHome = userInfo().homedir,
  query = readDefaultKeychain,
}) {
  if (platform !== "darwin") return null;
  let stage = "fixture-home";
  let code = "CODESHELL_KEYCHAIN_PREFLIGHT_FAILED";
  let identity;
  try {
    if (typeof home !== "string" || !isAbsolute(home) || /[\r\n\0]/.test(home))
      throw new Error("Fixture HOME must be an absolute path");
    const actualHome = realpathSync(home);
    if (actualHome !== resolve(home)) throw new Error("Fixture HOME cannot traverse symlinks");
    assertPrivateDirectory(actualHome);
    const accountHome = realpathSync(operatorHome);
    const accountInfo = lstatSync(accountHome);
    if (!accountInfo.isDirectory() || accountInfo.uid !== process.getuid())
      throw new Error("The original account HOME must be an owned real directory");
    if (actualHome === accountHome) throw new Error("Fixture HOME cannot be the account HOME");
    if (
      environment.HOME !== actualHome ||
      (environment.USERPROFILE !== undefined && environment.USERPROFILE !== actualHome)
    )
      throw new Error(
        "The final Electron HOME and USERPROFILE must match the private fixture HOME",
      );

    const referenceFile = join(actualHome, "electron-keychain-reference.json");
    const receiptFile = join(actualHome, "electron-keychain-context.json");
    const preferenceDirectory = join(actualHome, "Library", "Preferences");
    for (const directory of [join(actualHome, "Library"), preferenceDirectory]) {
      const info = existing(directory);
      if (info) assertPrivateDirectory(directory, info);
    }
    const preferenceFile = join(preferenceDirectory, "com.apple.security.plist");
    const preferenceInfo = existing(preferenceFile);
    if (preferenceInfo) assertPrivateFile(preferenceInfo, 1_024);
    const receiptInfo = existing(receiptFile);
    if (receiptInfo) assertPrivateFile(receiptInfo, 4_096);

    stage = "pinned-reference";
    const pinned = existing(referenceFile) ? readReference(referenceFile) : undefined;
    const explicitFile = environment.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE;
    if (explicitFile !== undefined && (typeof explicitFile !== "string" || !explicitFile))
      throw new Error("An explicit Keychain metadata reference must name a private regular file");
    const explicit = explicitFile === undefined ? undefined : readReference(explicitFile);
    for (const reference of [pinned, explicit]) {
      if (reference && reference.home !== accountHome)
        throw new Error("The Keychain reference must identify the original account HOME");
    }
    if (pinned && explicit && !sameFile(pinned, explicit)) {
      code = "CODESHELL_KEYCHAIN_PREFLIGHT_REFERENCE_MISMATCH";
      identity = identityMatches(pinned, explicit);
      throw new Error("The explicit and pinned Keychain metadata references disagree");
    }
    if (pinned && !preferenceInfo)
      throw new Error("The pinned fixture is missing its Keychain preference");
    if (!pinned && preferenceInfo && !explicit)
      throw new Error(
        "Existing preferences require an explicit native-acceptance metadata reference",
      );
    if (!pinned && receiptInfo)
      throw new Error(
        "Existing fixture receipts cannot be overwritten or adopted without a pinned reference",
      );

    stage = "account-before";
    let reference = pinned ?? explicit;
    if (!reference) reference = { version: 1, home: accountHome, ...query(accountHome) };
    const xml = keychainPreferenceXml(reference.path);
    const check = (contextHome, checkStage) => {
      stage = checkStage;
      const current = { home: accountHome, ...query(contextHome) };
      if (!sameFile(reference, current)) {
        code = "CODESHELL_KEYCHAIN_PREFLIGHT_IDENTITY_CHANGED";
        identity = identityMatches(reference, current);
        throw new Error(
          "The existing default Keychain identity changed or the private default differs",
        );
      }
    };

    if (preferenceInfo) {
      check(accountHome, "account-before");
      stage = "private-preference";
      verifyPreference(preferenceFile, xml);
      check(actualHome, "private");
      check(accountHome, "account-after");
      if (!pinned) {
        writeFileSync(
          receiptFile,
          `${JSON.stringify({
            pid: process.pid,
            ppid: process.ppid,
            homeHash: hash(actualHome),
            defaultPathHash: reference.pathHash,
            privateDefaultMatches: true,
            operatorDefaultUnchanged: true,
            adoptedCanonicalPreference: true,
          })}\n`,
          { flag: "wx", mode: 0o600 },
        );
      }
    } else {
      stage = "bind-private-context";
      bindPrivateKeychainContext({
        home: actualHome,
        root: dirname(actualHome),
        reference,
        receiptFile,
        query,
      });
      verifyPreference(preferenceFile, xml);
    }

    if (!pinned) {
      stage = "pin-reference";
      const serialized = `${JSON.stringify(reference)}\n`;
      if (Buffer.byteLength(serialized) > 4_096)
        throw new Error("The verified Keychain metadata reference exceeds 4KiB");
      writeFileSync(referenceFile, serialized, { flag: "wx", mode: 0o600 });
    }
    return { home: actualHome, referenceFile, receiptFile, reused: Boolean(pinned) };
  } catch (cause) {
    const error = new Error(
      `macOS Keychain preflight failed while ${stages[stage]}. Check the existing default login Keychain and the fixture metadata, then retry. Electron was not started by this preflight invocation; this check does not launch new Electron processes.`,
      { cause },
    );
    Object.defineProperties(error, {
      code: { value: code, enumerable: true },
      preflightStage: { value: stage, enumerable: true },
    });
    diagnostics.set(
      error,
      Object.freeze({
        version: 1,
        code,
        stage,
        launchStarted: false,
        ...(identity ? { identity } : {}),
      }),
    );
    throw error;
  }
}
