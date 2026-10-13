import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildComputerUseDriver, type CuaDriverLock } from "./build-computer-use-driver";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type CheckFailure = "architecture" | "signature" | "version" | "executable";

async function fixture(failure?: CheckFailure) {
  const directory = await mkdtemp(join(tmpdir(), "codeshell-cua-supply-"));
  directories.push(directory);
  const archiveBytes = Buffer.from("isolated Cua archive fixture");
  const binaryBytes = Buffer.from("isolated Cua executable fixture");
  const licenseBytes = "MIT fixture license\n";
  const lock: CuaDriverLock = {
    version: "0.34.1",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.1/cua-driver-rs-0.34.1-darwin-universal-binary.tar.gz",
    sha256: hash(archiveBytes),
    licenseUrl:
      "https://raw.githubusercontent.com/trycua/cua/0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc/LICENSE.md",
    licenseSha256: hash(licenseBytes),
  };
  const outputDirectory = join(directory, "output/cua-driver");
  const cacheDirectory = join(directory, "cache");
  const archivePath = join(cacheDirectory, `${lock.sha256}.tar.gz`);
  const licensePath = join(directory, "LICENSE");
  await writeFile(licensePath, licenseBytes);
  const calls: { command: string; args: string[] }[] = [];
  const downloads: string[] = [];
  const options = {
    platform: "darwin" as const,
    outputDirectory,
    cacheDirectory,
    licensePath,
    lock,
    offline: false,
    fetch: async (url: string | URL | Request) => {
      downloads.push(String(url));
      return new Response(archiveBytes);
    },
    run: async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === "/usr/bin/tar") {
        expect(args).toEqual(["-xzf", archivePath, "-C", expect.any(String), "cua-driver"]);
        await writeFile(join(args[3]!, "cua-driver"), failure === "executable" ? "" : binaryBytes);
        return { stdout: "" };
      }
      if (command === "/usr/bin/lipo") {
        return { stdout: failure === "architecture" ? "arm64\n" : "x86_64 arm64\n" };
      }
      if (command === "/usr/bin/codesign") {
        if (failure === "signature") throw new Error("fixture invalid signature");
        return { stdout: "" };
      }
      if (basename(command) === "cua-driver" && args.join(" ") === "--version") {
        return { stdout: failure === "version" ? "cua-driver 0.0.1\n" : "cua-driver 0.34.1\n" };
      }
      throw new Error(`Unexpected native command: ${command}`);
    },
  };
  return {
    options,
    directory,
    archivePath,
    archiveBytes,
    binaryBytes,
    licenseBytes,
    calls,
    downloads,
    async cache(bytes = archiveBytes) {
      await mkdir(cacheDirectory, { recursive: true });
      await writeFile(archivePath, bytes);
    },
    async expectNoOutput() {
      expect(existsSync(outputDirectory)).toBe(false);
      if (existsSync(join(directory, "output"))) {
        expect(await readdir(join(directory, "output"))).toEqual([]);
      }
    },
  };
}

describe("Cua Driver build supply", () => {
  test.each(["linux", "win32"] as const)(
    "%s skips all files, downloads and commands",
    async (platform) => {
      const h = await fixture();
      await buildComputerUseDriver({
        ...h.options,
        platform,
        licensePath: join(h.directory, "missing-license"),
        lock: { ...h.options.lock, version: "invalid" },
      });
      expect(h.calls).toEqual([]);
      expect(h.downloads).toEqual([]);
      expect(existsSync(h.options.cacheDirectory)).toBe(false);
      await h.expectNoOutput();
    },
  );

  test("offline mode fails on a missing verified archive without downloading", async () => {
    const h = await fixture();
    await expect(buildComputerUseDriver({ ...h.options, offline: true })).rejects.toThrow(
      "unavailable in offline cache",
    );
    expect(h.calls).toEqual([]);
    expect(h.downloads).toEqual([]);
    await h.expectNoOutput();
  });

  test("offline mode rejects a corrupt cache without extracting it", async () => {
    const h = await fixture();
    await h.cache(Buffer.from("corrupt cached archive"));
    await expect(buildComputerUseDriver({ ...h.options, offline: true })).rejects.toThrow(
      "unavailable in offline cache",
    );
    expect(h.calls).toEqual([]);
    expect(h.downloads).toEqual([]);
    await h.expectNoOutput();
  });

  test("verified cache is reused offline and publishes the checked CLI plus license", async () => {
    const h = await fixture();
    await h.cache();
    await buildComputerUseDriver({ ...h.options, offline: true });
    expect(h.downloads).toEqual([]);
    expect(h.calls.map(({ command }) => basename(command))).toEqual([
      "tar",
      "lipo",
      "codesign",
      "cua-driver",
    ]);
    expect(h.calls[2]!.args.slice(0, 2)).toEqual(["--verify", "--strict"]);
    expect(await readFile(join(h.options.outputDirectory, "cua-driver"))).toEqual(h.binaryBytes);
    expect((await stat(join(h.options.outputDirectory, "cua-driver"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(h.options.outputDirectory, "LICENSE"), "utf8")).toBe(h.licenseBytes);
    expect(await readdir(join(h.directory, "output"))).toEqual(["cua-driver"]);
  });

  test("an online build replaces corrupt cache only with checksum-verified bytes", async () => {
    const h = await fixture();
    await h.cache(Buffer.from("corrupt cached archive"));
    await buildComputerUseDriver(h.options);
    expect(h.downloads).toEqual([h.options.lock.url]);
    expect(await readFile(h.archivePath)).toEqual(h.archiveBytes);
    expect(await readdir(h.options.cacheDirectory)).toEqual([basename(h.archivePath)]);
    expect(await readFile(join(h.options.outputDirectory, "cua-driver"))).toEqual(h.binaryBytes);
  });

  test("a downloaded checksum mismatch never enters cache or publishes an executable", async () => {
    const h = await fixture();
    await expect(
      buildComputerUseDriver({
        ...h.options,
        fetch: async () => new Response("unverified download"),
      }),
    ).rejects.toThrow("archive checksum mismatch");
    expect(h.calls).toEqual([]);
    expect(await readdir(h.options.cacheDirectory)).toEqual([]);
    await h.expectNoOutput();
  });

  test.each(["http", "transport"] as const)(
    "%s download failure cleans temporary files",
    async (failure) => {
      const h = await fixture();
      await expect(
        buildComputerUseDriver({
          ...h.options,
          fetch: async () => {
            if (failure === "transport") throw new Error("fixture connection failed");
            return new Response("unavailable", { status: 503 });
          },
        }),
      ).rejects.toThrow(failure === "transport" ? "fixture connection failed" : "HTTP 503");
      expect(h.calls).toEqual([]);
      expect(await readdir(h.options.cacheDirectory)).toEqual([]);
      await h.expectNoOutput();
    },
  );

  test.each([
    ["architecture", "both macOS architectures"],
    ["signature", "fixture invalid signature"],
    ["version", "version does not match release lock"],
    ["executable", "no regular executable"],
  ] as const)("%s verification failure cannot publish the CLI", async (failure, message) => {
    const h = await fixture(failure);
    await h.cache();
    await expect(buildComputerUseDriver({ ...h.options, offline: true })).rejects.toThrow(message);
    expect(h.downloads).toEqual([]);
    await h.expectNoOutput();
    expect(await readFile(h.archivePath)).toEqual(h.archiveBytes);
  });

  test("a license mismatch fails before any cache, download or command", async () => {
    const h = await fixture();
    await writeFile(h.options.licensePath, "unverified license");
    await expect(buildComputerUseDriver(h.options)).rejects.toThrow("license checksum mismatch");
    expect(existsSync(h.options.cacheDirectory)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.downloads).toEqual([]);
    await h.expectNoOutput();
  });

  test("an unexpected release URL is rejected before any download", async () => {
    const h = await fixture();
    await expect(
      buildComputerUseDriver({
        ...h.options,
        lock: { ...h.options.lock, url: "https://untrusted.invalid/cua-driver.tar.gz" },
      }),
    ).rejects.toThrow("Invalid Cua Driver release lock");
    expect(h.calls).toEqual([]);
    expect(h.downloads).toEqual([]);
    await h.expectNoOutput();
  });
});

test("the standard macOS build packages Cua Driver at the runtime discovery path", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(packageJson.build.mac.extraResources).toContainEqual({
    from: "out/native/cua-driver",
    to: "cua-driver",
  });
  expect(packageJson.build.files).toContain("!out/cua-driver-cache{,/**/*}");
  expect(packageJson.build.files).toContain("!out/native{,/**/*}");
  const build = await readFile(new URL("./build.ts", import.meta.url), "utf8");
  expect(build).toMatch(/await Promise\.all\(\[[\s\S]*?\bbuildComputerUseDriver\(\)/);
});
