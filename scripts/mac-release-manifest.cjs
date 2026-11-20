// Write the old client's Darwin gate into the final dual-architecture macOS
// update manifest. Recovery verifies original artifacts without modifying them.
/* global require, module, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Also called from the CommonJS recovery tool. */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { parseDocument, isMap } = require("yaml");

const DARWIN_MINIMUM = "22.6.0";
const MACOS_MINIMUM = "13.5";

function readManifest(path) {
  const doc = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (doc.errors.length) throw doc.errors[0];
  assert(isMap(doc.contents), `Expected an updater manifest mapping: ${path}`);
  return doc;
}

function verifyFile(path, entry) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    assert(
      stat.isFile() && stat.size > 0 && stat.size === entry.size,
      `ZIP size mismatch: ${path}`,
    );
    const hash = createHash("sha512");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let bytes;
    while ((bytes = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
    assert.equal(hash.digest("base64"), entry.sha512, `ZIP SHA-512 mismatch: ${path}`);
  } finally {
    closeSync(fd);
  }
}

function verifyMacManifest(directory, version) {
  const data = readManifest(join(directory, "latest-mac.yml")).toJS();
  assert.equal(data.version, version, "Updater version does not match the release");
  assert.equal(data.minimumSystemVersion, DARWIN_MINIMUM, "Incorrect Darwin minimumSystemVersion");
  assert(Array.isArray(data.files), "Mac manifest requires files");
  const expected = [`code-shell-${version}-mac.zip`, `code-shell-${version}-arm64-mac.zip`];
  const zips = data.files.filter(
    (entry) => typeof entry?.url === "string" && /\.zip$/i.test(entry.url),
  );
  assert.deepEqual(
    zips.map((entry) => entry.url).sort(),
    expected.sort(),
    "Expected both architecture ZIPs",
  );
  for (const entry of zips) verifyFile(join(directory, entry.url), entry);
  const primary = zips.find((entry) => entry.url === data.path);
  assert(primary && primary.sha512 === data.sha512, "Incorrect primary ZIP path or SHA-512");
}

function prepareMacManifest(directory, version) {
  const path = join(directory, "latest-mac.yml");
  const doc = readManifest(path);
  if (!doc.has("minimumSystemVersion")) {
    doc.set("minimumSystemVersion", DARWIN_MINIMUM);
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, doc.toString(), { flag: "wx" });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  // Always re-read the final file, including on retries. Conflicting producer
  // metadata must fail rather than be silently overwritten.
  verifyMacManifest(directory, version);
}

function verifyMacBundles(directory) {
  for (const [arch, bundle] of [
    ["arm64", "mac-arm64"],
    ["x86_64", "mac"],
  ]) {
    const contents = join(directory, bundle, "code-shell.app", "Contents");
    const minimum = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", join(contents, "Info.plist")],
      { encoding: "utf8" },
    ).trim();
    assert.equal(minimum, MACOS_MINIMUM, `Unexpected system minimum in ${bundle}/Info.plist`);
    for (const binary of [
      "MacOS/code-shell",
      "Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      "Resources/runtimes/node/bin/node",
      "Library/CodeShell Computer Use.app/Contents/Resources/cua-driver",
    ]) {
      const path = join(contents, binary);
      const info = execFileSync("/usr/bin/xcrun", ["vtool", "-arch", arch, "-show-build", path], {
        encoding: "utf8",
      });
      const target = /\bplatform\s+MACOS\s+minos\s+(\d+(?:\.\d+){0,2})\b/.exec(info)?.[1];
      assert(target, `Missing ${arch} macOS deployment target in ${path}`);
      const [major, minor = 0, patch = 0] = target.split(".").map(Number);
      assert(
        major < 13 || (major === 13 && (minor < 5 || (minor === 5 && patch === 0))),
        `${path} (${arch}) requires macOS ${target}; release supports ${MACOS_MINIMUM}`,
      );
    }
  }
}

if (require.main === module) {
  const desktop = resolve(__dirname, "../packages/desktop");
  const directory = join(desktop, "dist");
  const pkg = require(join(desktop, "package.json"));
  assert.equal(pkg.build.mac.minimumSystemVersion, MACOS_MINIMUM);
  verifyMacBundles(directory);
  prepareMacManifest(directory, pkg.version);
}

module.exports = { prepareMacManifest, verifyMacManifest };
