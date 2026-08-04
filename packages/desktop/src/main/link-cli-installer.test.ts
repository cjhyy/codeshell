import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installManagedLinkCli, managedCliInstallStatus } from "./link-cli-installer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function githubFetch(archive: Uint8Array): typeof fetch {
  const checksum = createHash("sha256").update(archive).digest("hex");
  const release = {
    tag_name: "v1.2.3",
    assets: [
      {
        name: "gh_1.2.3_macOS_arm64.zip",
        browser_download_url: "https://github.com/cli/cli/releases/download/v1.2.3/gh.zip",
      },
      {
        name: "gh_1.2.3_checksums.txt",
        browser_download_url: "https://github.com/cli/cli/releases/download/v1.2.3/checksums.txt",
      },
    ],
  };
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify(release), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/gh.zip")) return new Response(archive);
    if (url.endsWith("/checksums.txt")) {
      return new Response(`${checksum}  gh_1.2.3_macOS_arm64.zip\n`);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("managed Link CLI installer", () => {
  test("verifies and installs the official GitHub CLI into the app-private path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-cli-installer-test-"));
    temporaryDirectories.push(root);
    const destination = join(root, "managed", "github", "gh");
    const archive = new TextEncoder().encode("official GitHub CLI archive");
    const runFile = async (_command: string, args: string[]) => {
      if (args[0] === "-tf") return "gh_1.2.3_macOS_arm64/bin/gh\n";
      const extractionRoot = args[args.indexOf("-C") + 1]!;
      const binaryDirectory = join(extractionRoot, "gh_1.2.3_macOS_arm64", "bin");
      await mkdir(binaryDirectory, { recursive: true });
      await writeFile(join(binaryDirectory, "gh"), "managed-gh");
      return "";
    };

    expect(managedCliInstallStatus("github", () => destination).managedInstalled).toBe(false);
    const result = await installManagedLinkCli("github", {
      fetch: githubFetch(archive),
      platform: "darwin",
      arch: "arm64",
      runFile,
      managedPath: () => destination,
    });

    expect(result).toMatchObject({
      providerId: "github",
      command: "gh",
      version: "1.2.3",
      executablePath: destination,
      source: "official-release",
      checksumVerified: true,
    });
    expect(await readFile(destination, "utf8")).toBe("managed-gh");
    expect(managedCliInstallStatus("github", () => destination).managedInstalled).toBe(true);
  });

  test("rejects an archive that tries to escape the extraction directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codeshell-cli-installer-test-"));
    temporaryDirectories.push(root);
    const archive = new TextEncoder().encode("unsafe archive");

    await expect(
      installManagedLinkCli("github", {
        fetch: githubFetch(archive),
        platform: "darwin",
        arch: "arm64",
        runFile: async () => "../gh\n",
        managedPath: () => join(root, "github", "gh"),
      }),
    ).rejects.toThrow("unsafe path");
  });

  test("keeps unsupported CLI providers on their official external install flow", () => {
    expect(managedCliInstallStatus("notion")).toMatchObject({
      providerId: "notion",
      supported: false,
      managedInstalled: false,
    });
  });
});
