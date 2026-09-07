import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  main,
  parsePublishArgs,
  publishCommands,
  publishReleasePackage,
  registryVersionExists,
  verifyRegistryTag,
  type PublishAttempt,
  type PublishRuntime,
} from "../scripts/publish-release-packages";
import {
  PUBLIC_RELEASE_PACKAGES,
  RELEASE_PACKAGES,
  packageManifestPath,
} from "../scripts/package-release-audit-config";

const name = "@cjhyy/code-shell";
const version = "0.9.7";
const command = publishCommands("latest").at(-1)!;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(exists: boolean[], results: PublishAttempt[]) {
  const logs: string[] = [];
  const delays: number[] = [];
  const published: string[][] = [];
  let lookups = 0;
  let attempts = 0;
  let tagChecks = 0;
  const runtime: PublishRuntime = {
    lookupVersion: async () => exists[lookups++] ?? false,
    verifyTag: async () => {
      tagChecks++;
    },
    publish: (args) => {
      published.push([...args]);
      return results[attempts++] ?? { status: 0 };
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (message) => {
      logs.push(message);
    },
  };
  return { runtime, logs, delays, published, counts: () => ({ lookups, attempts, tagChecks }) };
}

describe("resumable release publication", () => {
  test("skips an immutable existing version only after checking the requested tag", async () => {
    const run = fixture([true], []);
    expect(await publishReleasePackage(name, version, "latest", command, run.runtime)).toBe(
      "existing",
    );
    expect(run.counts()).toEqual({ lookups: 1, attempts: 0, tagChecks: 1 });
    expect(run.delays).toEqual([]);
  });

  test.each([
    "503 Service Unavailable: https://registry.npmjs.org/@cjhyy%2fcode-shell",
    "error: 429 Too Many Requests",
    "error: publish failed with status 502",
    "ECONNRESET",
  ])("retries a transient publish failure: %s", async (stderr) => {
    const run = fixture([false, false, false], [{ status: 1, stderr }, { status: 0 }]);
    expect(await publishReleasePackage(name, version, "latest", command, run.runtime)).toBe(
      "published",
    );
    expect(run.counts().attempts).toBe(2);
    expect(run.delays).toEqual([2_000]);
  });

  test("rechecks an ambiguous failure before republishing a version accepted by the registry", async () => {
    const run = fixture([false, true], [{ status: 1, stderr: "503 Service Unavailable" }]);
    expect(await publishReleasePackage(name, version, "latest", command, run.runtime)).toBe(
      "existing",
    );
    expect(run.counts()).toEqual({ lookups: 2, attempts: 1, tagChecks: 1 });
    expect(run.delays).toEqual([]);
  });

  test("bounds repeated transient failures and does not print child credentials", async () => {
    const secret = "npm_TOKEN_MUST_NOT_APPEAR";
    const run = fixture(
      [],
      Array.from({ length: 4 }, () => ({
        status: 1,
        stderr: `503 Service Unavailable: https://user:${secret}@registry.npmjs.org/`,
      })),
    );
    let failure = "";
    try {
      await publishReleasePackage(name, version, "latest", command, run.runtime);
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("attempt 4/4");
    expect(failure).not.toContain(secret);
    expect(run.logs.join("\n")).not.toContain(secret);
    expect(run.counts().attempts).toBe(4);
    expect(run.delays).toEqual([2_000, 5_000, 10_000]);
  });

  test("fails immediately on authentication errors without leaking raw output", async () => {
    const run = fixture([], [{ status: 1, stderr: "E403 token=npm_PRIVATE_TOKEN" }]);
    await expect(
      publishReleasePackage(name, version, "latest", command, run.runtime),
    ).rejects.toThrow("HTTP 403");
    expect(run.counts().attempts).toBe(1);
    expect(run.delays).toEqual([]);
    expect(run.logs.join("\n")).not.toContain("npm_PRIVATE_TOKEN");
  });

  test("does not infer an absent version or publish during a registry outage", async () => {
    const run = fixture([], []);
    run.runtime.lookupVersion = () =>
      registryVersionExists(name, version, async () => new Response("down", { status: 503 }));
    await expect(
      publishReleasePackage(name, version, "latest", command, run.runtime),
    ).rejects.toThrow("registry lookup returned HTTP 503");
    expect(run.counts().attempts).toBe(0);
    expect(run.delays).toEqual([2_000, 5_000, 10_000]);
  });

  test("an existing version with a different dist-tag requires explicit repair, never a downgrade", async () => {
    const run = fixture([true], []);
    run.runtime.verifyTag = () =>
      verifyRegistryTag(name, version, "latest", async () => Response.json({ latest: "0.10.0" }));
    await expect(
      publishReleasePackage(name, version, "latest", command, run.runtime),
    ).rejects.toThrow("repair it explicitly");
    expect(run.counts().attempts).toBe(0);
    expect(run.delays).toEqual([]);
  });
});

describe("public registry verification", () => {
  test("reads the exact scoped version without auth, bypassing a cached missing-version response", async () => {
    const urls: string[] = [];
    const request = async (url: URL, init: RequestInit) => {
      urls.push(url.href);
      expect(url.origin).toBe("https://registry.npmjs.org");
      expect(decodeURIComponent(url.pathname)).toBe(`/${name}/${version}`);
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).get("cache-control")).toBe("no-cache");
      return urls.length === 1
        ? new Response("missing", { status: 404 })
        : Response.json({ name, version });
    };
    expect(await registryVersionExists(name, version, request)).toBe(false);
    expect(await registryVersionExists(name, version, request)).toBe(true);
    expect(urls[0]).not.toBe(urls[1]);
  });

  test("does not accept another version, malformed metadata, or unauthorized reads", async () => {
    for (const response of [
      Response.json({ name, version: "0.9.6" }),
      Response.json({ name: "another-package", version }),
      new Response("unauthorized", { status: 401 }),
    ]) {
      await expect(registryVersionExists(name, version, async () => response)).rejects.toThrow(
        "registry lookup",
      );
    }
  });

  test("checks the requested dist-tag against exact registry metadata", async () => {
    await expect(
      verifyRegistryTag(name, version, "next", async (url, init) => {
        expect(decodeURIComponent(url.pathname)).toBe(`/-/package/${name}/dist-tags`);
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        return Response.json({ latest: "0.9.6", next: version });
      }),
    ).resolves.toBeUndefined();
  });
});

describe("release helper modes and target checkout", () => {
  test.each(["default", "--dry-run", "--list"])("keeps %s entirely local", async (mode) => {
    const run = fixture([], []);
    await main(mode === "default" ? [] : [mode], run.runtime);
    expect(run.counts()).toEqual({ lookups: 0, attempts: 0, tagChecks: 0 });
    expect(run.delays).toEqual([]);
    expect(run.logs.length).toBeGreaterThan(0);
  });

  test("resumes the release after nine already-published packages in dependency order", async () => {
    const run = fixture([...Array.from({ length: 9 }, () => true), false], [{ status: 0 }]);
    await main(["--execute"], run.runtime);
    expect(run.counts()).toEqual({ lookups: 10, attempts: 1, tagChecks: 9 });
    expect(run.published).toEqual([publishCommands("latest").at(-1)!]);
  });

  test("reads and verifies versions from an explicit target checkout", async () => {
    const target = mkdtempSync(join(tmpdir(), "codeshell-publish-target-"));
    roots.push(target);
    const repo = resolve(import.meta.dir, "..");
    const current = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
    const targetVersion = "10.2.3";
    for (const definition of RELEASE_PACKAGES) {
      const relative = packageManifestPath(definition);
      const manifest = JSON.parse(readFileSync(join(repo, relative), "utf8"));
      mkdirSync(dirname(join(target, relative)), { recursive: true });
      writeFileSync(
        join(target, relative),
        JSON.stringify({ ...manifest, version: targetVersion }),
      );
    }
    mkdirSync(join(target, "packages/core/src"), { recursive: true });
    writeFileSync(
      join(target, "packages/core/src/index.ts"),
      `export const VERSION = "${targetVersion}";\n`,
    );
    writeFileSync(
      join(target, "bun.lock"),
      readFileSync(join(repo, "bun.lock"), "utf8").replaceAll(current, targetVersion),
    );
    const run = fixture([], []);
    const versions: string[] = [];
    run.runtime.lookupVersion = async (_name, checkedVersion) => {
      versions.push(checkedVersion);
      return true;
    };
    await main(["--repo-root", target, "--tag", "next", "--execute"], run.runtime);
    expect(versions).toEqual(PUBLIC_RELEASE_PACKAGES.map(() => targetVersion));
    expect(run.counts().attempts).toBe(0);
    expect(parsePublishArgs(["--repo-root", target]).repoRoot).toBe(target);
    expect(() => parsePublishArgs(["--repo-root", "--execute"])).toThrow("requires a path");
  });
});
