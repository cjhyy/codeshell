import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const VERSION = "1.64.0";
const REGISTRY_SHA256 = "2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0";
const METADATA_SHA256 = "2cfd419f71ac6475d81e1301fa86c34cf2a2a6bae2a0da4b5a2b18310216b6bf";
const PLATFORM_PATHS = {
  chromium: {
    "linux-x64": ["chrome-linux64", "chrome"],
    "linux-arm64": ["chrome-linux-arm64", "chrome"],
    "win32-x64": ["chrome-win64", "chrome.exe"],
  },
  "chromium-headless-shell": {
    "linux-x64": ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    "linux-arm64": ["chrome-headless-shell-linux-arm64", "chrome-headless-shell"],
    "win32-x64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
  },
};

/** A source-derived path plan, not execution or a private Playwright API call.
 * The pinned 1.64 registry selects headless-shell when headless && !channel;
 * readDescriptors replaces name hyphens with underscores and appends revision.
 * Unknown registry/metadata bytes require a separately reviewed update.
 */
export function planServiceWorkerBrowserExecutable({
  packageMetadata,
  browsersMetadata,
  registrySourceSHA256,
  metadataSHA256,
  environment,
  platform,
  arch,
  headless = true,
}) {
  assert.equal(typeof headless, "boolean", "Browser headless selection must be explicit boolean");
  assert.equal(packageMetadata?.name, "playwright-core", "Unexpected browser package");
  assert.equal(packageMetadata.version, VERSION, "Unsupported installed Playwright version");
  assert.equal(registrySourceSHA256, REGISTRY_SHA256, "Unsupported installed registry source");
  assert.equal(metadataSHA256, METADATA_SHA256, "Unsupported installed browser metadata");
  assert.ok(Array.isArray(browsersMetadata?.browsers), "Malformed browser metadata");
  const name = headless ? "chromium-headless-shell" : "chromium";
  const matching = browsersMetadata.browsers.filter((entry) => entry?.name === name);
  assert.equal(matching.length, 1, "Expected exactly one selected Chromium descriptor");
  const descriptor = matching[0];
  assert.equal(descriptor.revision, "1248", "Unsupported Chromium revision");
  assert.equal(descriptor.installByDefault, true, "Unsupported Chromium install policy");
  assert.equal(
    descriptor.revisionOverrides,
    undefined,
    "Chromium revision overrides are unsupported",
  );
  assert.ok(
    (platform === "darwin" && ["x64", "arm64"].includes(arch)) ||
      Object.hasOwn(PLATFORM_PATHS[name], `${platform}-${arch}`),
    "Unsupported browser platform or architecture",
  );
  const paths = platform === "win32" ? path.win32 : path.posix;
  const override = environment.CODESHELL_TEST_CHROMIUM;
  if (override) {
    assert.equal(typeof override, "string", "Browser override must be a path");
    assert.ok(paths.isAbsolute(override), "Browser override must be absolute");
    assert.equal(
      paths.normalize(override),
      override,
      "Browser override must not contain path aliases",
    );
    return { executablePath: override, selection: "explicit-override", cacheRoot: null };
  }
  if (platform === "darwin")
    return {
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      selection: "legacy-darwin-chrome",
      cacheRoot: null,
    };
  const cacheRoot = environment.PLAYWRIGHT_BROWSERS_PATH;
  assert.equal(typeof cacheRoot, "string", "An explicit owned browser cache is required");
  assert.ok(paths.isAbsolute(cacheRoot), "Browser cache must be absolute");
  assert.equal(
    paths.normalize(cacheRoot),
    cacheRoot,
    "Browser cache must not contain path aliases",
  );
  const executablePath = paths.join(
    cacheRoot,
    `${name.replace(/-/g, "_")}-${descriptor.revision}`,
    ...PLATFORM_PATHS[name][`${platform}-${arch}`],
  );
  const relative = paths.relative(cacheRoot, executablePath);
  assert.ok(relative && !relative.startsWith("..") && !paths.isAbsolute(relative));
  return {
    executablePath,
    selection: headless ? "locked-headless-shell" : "locked-chromium",
    cacheRoot,
  };
}

async function pinRegularFile(filename, limit, includeBytes = false) {
  const absolute = path.resolve(filename);
  assert.equal(await realpath(absolute), absolute, "Browser metadata or binary path has an alias");
  const before = await lstat(absolute, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink(), "Expected a regular browser file");
  assert.ok(
    before.size > 0n && before.size <= BigInt(limit),
    "Browser file exceeds its byte bound",
  );
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const sameIdentity = (value) =>
    ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((key) => value[key] === before[key]);
  try {
    assert.ok(
      sameIdentity(await handle.stat({ bigint: true })),
      "Browser file changed before reading",
    );
    const hash = createHash("sha256");
    let bytes;
    if (includeBytes) {
      bytes = await handle.readFile();
      assert.equal(
        BigInt(bytes.length),
        before.size,
        "Browser metadata size changed while reading",
      );
      hash.update(bytes);
    } else {
      let count = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        count += chunk.length;
        assert.ok(count <= limit, "Browser binary exceeded its byte bound while reading");
        hash.update(chunk);
      }
      assert.equal(BigInt(count), before.size, "Browser binary size changed while reading");
    }
    assert.ok(
      sameIdentity(await handle.stat({ bigint: true })),
      "Browser file changed while reading",
    );
    assert.ok(
      sameIdentity(await lstat(absolute, { bigint: true })),
      "Browser file was replaced while reading",
    );
    return { filename: absolute, sha256: hash.digest("hex"), bytes, size: Number(before.size) };
  } finally {
    await handle.close();
  }
}

export async function resolveServiceWorkerBrowserExecutable({
  playwrightCorePackagePath,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  headless = true,
}) {
  assert.equal(platform, process.platform, "File pinning must use the actual filesystem platform");
  const packagePath = await realpath(playwrightCorePackagePath);
  assert.equal(path.basename(packagePath), "package.json", "Expected installed package metadata");
  const root = path.dirname(packagePath);
  const packagePin = await pinRegularFile(packagePath, 64 * 1024, true);
  const metadataPin = await pinRegularFile(path.join(root, "browsers.json"), 1024 * 1024, true);
  const sourcePin = await pinRegularFile(path.join(root, "lib/coreBundle.js"), 16 * 1024 * 1024);
  const plan = planServiceWorkerBrowserExecutable({
    packageMetadata: JSON.parse(packagePin.bytes.toString("utf8")),
    browsersMetadata: JSON.parse(metadataPin.bytes.toString("utf8")),
    registrySourceSHA256: sourcePin.sha256,
    metadataSHA256: metadataPin.sha256,
    environment,
    platform,
    arch,
    headless,
  });
  if (plan.cacheRoot)
    assert.equal(
      await realpath(plan.cacheRoot),
      plan.cacheRoot,
      "Owned browser cache has an alias",
    );
  const binaryPin = await pinRegularFile(plan.executablePath, 512 * 1024 * 1024);
  return {
    executablePath: binaryPin.filename,
    receipt: {
      selection: plan.selection,
      playwrightVersion: VERSION,
      platform,
      arch,
      headless,
      revision: plan.cacheRoot ? "1248" : null,
      packageSHA256: packagePin.sha256,
      metadataSHA256: metadataPin.sha256,
      registrySourceSHA256: sourcePin.sha256,
      executableSHA256: binaryPin.sha256,
      executableBytes: binaryPin.size,
      boundary:
        "Read-only pinned installed 1.64.0 metadata and registry rules; binary bytes are hashed, never executed for discovery. Default non-darwin resolution requires an explicit absolute owned browser cache. This is path/byte identity evidence, not a native browser run.",
    },
  };
}
