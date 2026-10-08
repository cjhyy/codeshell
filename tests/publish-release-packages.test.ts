import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
  let elapsed = 0;
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
      elapsed += ms;
    },
    now: () => elapsed,
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
    const run = fixture([false, false, false, true], [{ status: 1, stderr }, { status: 0 }]);
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

  test("accepts exit zero only after an exact version and requested tag read", async () => {
    const run = fixture([false, true], [{ status: 0 }]);
    run.runtime.verifyTag = async () => {
      expect(run.logs.some((message) => message.includes("✓ Published"))).toBe(false);
    };
    expect(await publishReleasePackage(name, version, "next", command, run.runtime)).toBe(
      "published",
    );
    expect(run.counts().attempts).toBe(1);
    expect(run.logs.at(-1)).toContain("public exact version and dist-tag next confirmed");
  });

  test("allows five minutes of public visibility delay without publishing again", async () => {
    const run = fixture([], [{ status: 0 }]);
    run.runtime.lookupVersion = async () => run.runtime.now() >= 5 * 60_000;
    expect(await publishReleasePackage(name, version, "latest", command, run.runtime)).toBe(
      "published",
    );
    expect(run.counts().attempts).toBe(1);
    expect(run.runtime.now()).toBe(5 * 60_000);
    expect(run.counts().tagChecks).toBe(1);
  });

  test("times out an accepted but invisible version without another publish or a success log", async () => {
    const run = fixture([], [{ status: 0 }]);
    await expect(
      publishReleasePackage(name, version, "latest", command, run.runtime),
    ).rejects.toThrow("public registry confirmation timed out after 600s");
    expect(run.counts().attempts).toBe(1);
    expect(run.counts().tagChecks).toBe(0);
    expect(run.runtime.now()).toBe(600_000);
    expect(run.logs.join("\n")).not.toContain("✓ Published");
  });

  test("waits for a delayed tag, including transient public read failures", async () => {
    const run = fixture([false, ...Array.from({ length: 4 }, () => true)], [{ status: 0 }]);
    let reads = 0;
    run.runtime.verifyTag = () =>
      verifyRegistryTag(name, version, "latest", async () => {
        reads++;
        if (reads === 1) return new Response("missing", { status: 404 });
        if (reads === 2) return new Response("down", { status: 503 });
        return Response.json({ latest: reads === 3 ? "0.9.6" : version });
      });
    expect(await publishReleasePackage(name, version, "latest", command, run.runtime)).toBe(
      "published",
    );
    expect(run.counts().attempts).toBe(1);
    expect(run.delays).toEqual([10_000, 10_000, 10_000]);
  });

  test("never moves a newer tag when the publisher reported success", async () => {
    const run = fixture([], [{ status: 0 }]);
    run.runtime.lookupVersion = async () => run.counts().attempts > 0;
    run.runtime.verifyTag = () =>
      verifyRegistryTag(name, version, "latest", async () => Response.json({ latest: "0.10.0" }));
    await expect(
      publishReleasePackage(name, version, "latest", command, run.runtime),
    ).rejects.toThrow("do not automatically republish or move dist-tags");
    expect(run.counts().attempts).toBe(1);
    expect(run.runtime.now()).toBe(600_000);
    expect(run.logs.join("\n")).not.toContain("✓ Published");
  });

  test("preserves permanent read failures and redacts unexpected confirmation errors", async () => {
    for (const permanent of [true, false]) {
      const run = fixture([], [{ status: 0, stdout: "npm_PUBLISH_SECRET" }]);
      run.runtime.lookupVersion = async () => {
        if (run.counts().attempts === 0) return false;
        if (!permanent) throw new Error("npm_READ_SECRET");
        return registryVersionExists(
          name,
          version,
          async () => new Response("no", { status: 401 }),
        );
      };
      await expect(
        publishReleasePackage(name, version, "latest", command, run.runtime),
      ).rejects.toThrow(permanent ? "HTTP 401" : "registry confirmation failed");
      expect(run.counts().attempts).toBe(1);
      expect(run.delays).toEqual([]);
      expect(run.logs.join("\n")).not.toContain("SECRET");
    }
  });

  test("caps reads by the remaining global deadline and rejects a late tag response", async () => {
    const run = fixture([], [{ status: 0 }]);
    let clock = 0;
    run.runtime.now = () => clock;
    run.runtime.lookupVersion = async (_name, _version, timeoutMs) => {
      if (run.counts().attempts === 0) return false;
      expect(timeoutMs).toBe(15_000);
      clock = 597_000;
      return true;
    };
    run.runtime.verifyTag = async (_name, _version, _tag, timeoutMs) => {
      expect(timeoutMs).toBe(3_000);
      clock += timeoutMs!;
    };
    await expect(
      publishReleasePackage(name, version, "latest", command, run.runtime),
    ).rejects.toThrow("confirmation timed out");
    expect(run.counts().attempts).toBe(1);
    expect(run.logs.join("\n")).not.toContain("✓ Published");
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

  test("resumes the release after every earlier package is already published", async () => {
    // Derived from the public release set so the scenario stays "all but the
    // last are published, resume on the final one" as that set changes.
    const alreadyPublished = PUBLIC_RELEASE_PACKAGES.length - 1;
    const run = fixture(
      [...Array.from({ length: alreadyPublished }, () => true), false, true],
      [{ status: 0 }],
    );
    await main(["--execute"], run.runtime);
    expect(run.counts()).toEqual({
      lookups: alreadyPublished + 2,
      attempts: 1,
      tagChecks: alreadyPublished + 1,
    });
    expect(run.published).toEqual([publishCommands("latest").at(-1)!]);
  });

  test("submits all packages before concurrent confirmation under one batch budget", async () => {
    const run = fixture([], []);
    const total = PUBLIC_RELEASE_PACKAGES.length;
    let confirmations = 0;
    let releaseReads!: () => void;
    const gate = new Promise<void>((done) => (releaseReads = done));
    run.runtime.lookupVersion = async () => {
      if (run.counts().attempts < total) return false;
      confirmations++;
      if (confirmations === total) releaseReads();
      await gate;
      return true;
    };
    await main(["--execute"], run.runtime);
    expect(run.counts().attempts).toBe(total);
    expect(run.counts().tagChecks).toBe(total);
    expect(confirmations).toBe(total);
    expect(run.delays).toEqual([]);
  }, 1_000);

  test("bounds a whole invisible batch at ten minutes, rather than ten minutes per package", async () => {
    const run = fixture([], []);
    await expect(main(["--execute"], run.runtime)).rejects.toThrow(
      "confirmation timed out after 600s",
    );
    expect(run.counts().attempts).toBe(PUBLIC_RELEASE_PACKAGES.length);
    expect(run.runtime.now()).toBe(600_000);
    expect(run.logs.join("\n")).not.toContain("✓ Published");
  });

  test("Bun publish --cwd selects the intended package in an isolated dry run", () => {
    const target = mkdtempSync(join(tmpdir(), "codeshell-publish-cwd-"));
    roots.push(target);
    const child = join(target, "packages", "child");
    const home = join(target, "home");
    mkdirSync(child, { recursive: true });
    mkdirSync(home);
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "cwd-root-fixture", version: "1.0.0" }),
    );
    writeFileSync(
      join(child, "package.json"),
      JSON.stringify({ name: "cwd-child-fixture", version: "2.0.0" }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "publish",
        "--cwd",
        "packages/child",
        "--dry-run",
        "--ignore-scripts",
        "--registry",
        "http://127.0.0.1:1",
      ],
      {
        cwd: target,
        // No inherited credentials or operator configuration. The unreachable
        // registry also makes an accidental publish fail rather than write.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          // Bun 1.3.11 requires a token even for --dry-run; this fixture value
          // grants no authority and the only configured origin is loopback.
          NPM_CONFIG_TOKEN: "dry-run-fixture-token",
        },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}\n${result.stderr}`).toContain("cwd-child-fixture@2.0.0");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("cwd-root-fixture@1.0.0");
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
