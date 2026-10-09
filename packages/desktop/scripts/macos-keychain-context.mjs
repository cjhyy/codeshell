import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Metadata only: this never lists keychains or reads any password/item. */
export function readDefaultKeychain(home) {
  const environment = { HOME: home, PATH: "/usr/bin:/bin", NODE_USE_ENV_PROXY: "0" };
  for (const key of ["USER", "LOGNAME", "SECURITYSESSIONID"])
    if (process.env[key]) environment[key] = process.env[key];
  const stdout = execFileSync("/usr/bin/security", ["default-keychain", "-d", "user"], {
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4_096,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const path = JSON.parse(stdout.trim());
  if (typeof path !== "string" || !isAbsolute(path) || /[\r\n\0]/.test(path))
    throw new Error("Default Keychain metadata did not return one absolute path");
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid())
    throw new Error("Default Keychain metadata does not identify the existing user's regular file");
  return { path, pathHash: hash(path), dev: file.dev, ino: file.ino, uid: file.uid };
}

export function readKeychainReference(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let reference;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4_096 || stat.mode & 0o077 || stat.uid !== process.getuid())
      throw new Error("Keychain metadata input must be a bounded private regular file");
    reference = JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
  if (
    reference.version !== 1 ||
    typeof reference.home !== "string" ||
    !isAbsolute(reference.home) ||
    /[\r\n\0]/.test(reference.home) ||
    typeof reference.path !== "string" ||
    !isAbsolute(reference.path) ||
    /[\r\n\0]/.test(reference.path) ||
    reference.pathHash !== hash(reference.path) ||
    !Number.isSafeInteger(reference.dev) ||
    reference.dev < 0 ||
    !Number.isSafeInteger(reference.ino) ||
    reference.ino < 0 ||
    reference.uid !== process.getuid()
  )
    throw new Error("Invalid default Keychain metadata reference");
  return reference;
}

export function keychainPreferenceXml(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\r\n\0]/.test(path))
    throw new Error("Keychain reference requires an absolute metadata path");
  const escaped = path.replace(/[<>&"']/g, (char) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[char];
  });
  // Apple Security DLDBListCFPref's DefaultKeychain singleton, with the public
  // AppleCSPDL GUID and CSSM_SERVICE_CSP | CSSM_SERVICE_DL (2 | 4). No search list.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>DefaultKeychain</key><array><dict>
<key>DbName</key><string>${escaped}</string>
<key>GUID</key><string>{87191ca3-0fc9-11d4-849a-000502b52122}</string>
<key>SubserviceType</key><integer>6</integer>
</dict></array></dict></plist>\n`;
  if (Buffer.byteLength(xml) > 1_024) throw new Error("Private Keychain reference exceeds 1KiB");
  return xml;
}

const sameFile = (a, b) =>
  a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

/** Reference the same existing OS default from a fresh private fixture HOME. */
export function bindPrivateKeychainContext({
  home,
  root,
  reference,
  receiptFile,
  query = readDefaultKeychain,
}) {
  const actualHome = realpathSync(home);
  const actualRoot = realpathSync(root);
  const within = relative(actualRoot, actualHome);
  if (
    !within ||
    within.startsWith("..") ||
    isAbsolute(within) ||
    actualHome !== resolve(home) ||
    !lstatSync(home).isDirectory()
  )
    throw new Error("Keychain context requires a real HOME inside the private fixture root");
  const before = query(reference.home);
  if (!sameFile(reference, before)) throw new Error("The OS default Keychain metadata changed");
  let directory = actualHome;
  for (const name of ["Library", "Preferences"]) {
    directory = join(directory, name);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const folder = lstatSync(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink() || realpathSync(directory) !== directory)
      throw new Error("Private Keychain preferences cannot traverse a symlink");
  }
  const file = join(directory, "com.apple.security.plist");
  const xml = keychainPreferenceXml(before.path);
  writeFileSync(file, xml, { flag: "wx", mode: 0o600 });
  const privateDefault = query(actualHome);
  const after = query(reference.home);
  if (!sameFile(before, privateDefault) || !sameFile(before, after))
    throw new Error("Private Keychain context did not preserve the existing OS default");
  const receipt = {
    pid: process.pid,
    ppid: process.ppid,
    homeHash: hash(actualHome),
    defaultPathHash: before.pathHash,
    existingRegularFile: true,
    privateDefaultMatches: true,
    operatorDefaultUnchanged: true,
    preferenceBytes: Buffer.byteLength(xml),
    preferenceMode: statSync(file).mode & 0o777,
    scope:
      "new private plist singleton only; no keychain data/search-list copy, symlink, unlock, create, or OS-default mutation",
  };
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, file, ...extra] = process.argv.slice(2);
  if (process.platform !== "darwin" || flag !== "--capture" || !file || extra.length)
    throw new Error("usage: node macos-keychain-context.mjs --capture <new-private-metadata-file>");
  const home = realpathSync(process.env.HOME);
  const reference = { version: 1, home, ...readDefaultKeychain(home) };
  writeFileSync(file, `${JSON.stringify(reference)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ capturedDefaultMetadata: true, pathHash: reference.pathHash }));
}
