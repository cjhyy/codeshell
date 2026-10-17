import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePackagedUiAcceptanceArguments,
  readPackagedUiBuildReceipt,
} from "./run-packaged-ui-acceptance.mjs";

test("packaged entry defaults to UI and accepts only the reviewed updater alternative", () => {
  const base = ["--build-receipt", "/owned/receipt.json", "--evidence-dir", "/owned/evidence"];
  expect(parsePackagedUiAcceptanceArguments(base).fixture).toBe("ui");
  expect(parsePackagedUiAcceptanceArguments([...base, "--fixture", "updater"]).fixture).toBe(
    "updater",
  );
  for (const args of [
    [...base, "--fixture", "../../arbitrary-script"],
    [...base, "--fixture", "updater", "--fixture", "ui"],
    [...base, "--script", "updater"],
    [...base, "--fixture"],
    ["--fixture", "updater"],
  ])
    expect(() => parsePackagedUiAcceptanceArguments(args)).toThrow();
});

test("AppImage receipt stays limited to the native Linux x64 updater fixture", () => {
  const base = [
    "--build-receipt",
    "/owned/build.json",
    "--evidence-dir",
    "/owned/evidence",
    "--appimage-build-receipt",
    "/owned/image.json",
  ];
  const linux = { platform: "linux", arch: "x64" };
  const args = [...base, "--fixture", "updater"];
  expect(parsePackagedUiAcceptanceArguments(args, linux).appImageBuildReceipt).toBe(
    "/owned/image.json",
  );
  for (const [input, target] of [
    [base, linux],
    [args, { platform: "darwin", arch: "x64" }],
    [args, { platform: "win32", arch: "x64" }],
    [args, { platform: "linux", arch: "arm64" }],
    [[...args, "--appimage-build-receipt", "/other.json"], linux],
    [[...args, "--appimage-build-receipt"], linux],
  ])
    expect(() => parsePackagedUiAcceptanceArguments(input, target)).toThrow();
});

const sourceHead = "a".repeat(40);
let root;
let file;
let receipt;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codeshell-package-input-"));
  const output = join(root, "output");
  const appRoot = join(output, "native-app");
  await mkdir(appRoot, { recursive: true });
  file = join(root, "build-receipt.json");
  receipt = {
    status: "passed",
    platform: process.platform,
    arch: process.arch,
    sourceHead,
    sourceDirty: false,
    appAsarSha256: "1".repeat(64),
    managedNodeManifestSha256: "2".repeat(64),
    output,
    appRoot,
    publishing: false,
    notarization: false,
    developerIdentity: false,
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const read = async (changes = {}) => {
  await writeFile(file, JSON.stringify({ ...receipt, ...changes }), { mode: 0o600 });
  return readPackagedUiBuildReceipt(file, { sourceHead });
};

test("accepts an owned native build from the exact source commit", async () => {
  const value = await read();
  expect(value.sourceHead).toBe(sourceHead);
  expect(value.appRoot).toEndWith("native-app");
});

test.each([
  ["status", "failed"],
  ["platform", "another-host"],
  ["arch", "another-architecture"],
  ["sourceHead", "b".repeat(40)],
  ["sourceDirty", true],
  ["appAsarSha256", "missing-hash"],
  ["managedNodeManifestSha256", "missing-hash"],
  ["publishing", true],
  ["notarization", true],
  ["developerIdentity", true],
])("rejects a misleading %s before executing any package", async (key, value) => {
  await expect(read({ [key]: value })).rejects.toThrow();
});

test("rejects a package or symlink whose canonical path escapes output", async () => {
  const outside = join(root, "outside-app");
  await mkdir(outside);
  await expect(read({ appRoot: outside })).rejects.toThrow(/inside/);
  const alias = join(receipt.output, "alias");
  await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(read({ appRoot: alias })).rejects.toThrow(/inside/);
});

test("rejects symlink and oversized receipt inputs", async () => {
  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify(receipt));
  await symlink(target, file);
  await expect(readPackagedUiBuildReceipt(file, { sourceHead })).rejects.toThrow(/regular/);
  await rm(file);
  await writeFile(file, " ".repeat(64 * 1024 + 1));
  await expect(readPackagedUiBuildReceipt(file, { sourceHead })).rejects.toThrow(/bounded/);
});
