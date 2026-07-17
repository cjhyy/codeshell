import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { installPluginFromNpm, resolveNpmPlugin } from "./installFromNpm.js";
import { parseNpmPluginSource } from "./parseSource.js";
import { readInstalledPlugins } from "../installedPlugins.js";

const STAMP = "2026-07-17T02:00:00.000Z";

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii");
}

function tarFile(name: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(body.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function pluginTarball(packageJson: Record<string, unknown> = {}): Buffer {
  const manifest = {
    name: "@acme/safe-plugin",
    version: "1.2.3",
    scripts: { install: "touch SHOULD_NEVER_EXIST" },
    ...packageJson,
  };
  const pluginManifest = {
    name: "safe-plugin",
    version: "1.2.3",
    description: "safe npm plugin",
  };
  return gzipSync(
    Buffer.concat([
      tarFile("package/package.json", JSON.stringify(manifest)),
      tarFile("package/.codex-plugin/plugin.json", JSON.stringify(pluginManifest)),
      tarFile(
        "package/skills/demo/SKILL.md",
        "---\nname: demo\ndescription: safe\n---\nDo safe work.",
      ),
      Buffer.alloc(1024),
    ]),
  );
}

function integrity(tarball: Buffer): string {
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

function registryFetch(
  tarball: Buffer,
  metadataOverrides: Record<string, unknown> = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const metadata = {
    name: "@acme/safe-plugin",
    version: "1.2.3",
    dist: {
      tarball: "https://registry.npmjs.org/@acme/safe-plugin/-/safe-plugin-1.2.3.tgz",
      integrity: integrity(tarball),
    },
    ...metadataOverrides,
  };
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname.endsWith(".tgz")) {
      return new Response(tarball, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(tarball.length),
        },
      });
    }
    const body = JSON.stringify(metadata);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    });
  };
}

describe("public npm plugin install Phase A", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-npm-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("resolves a tag, verifies a snapshot, installs without lifecycle scripts, and locks exact version", async () => {
    const tarball = pluginTarball();
    const parsed = parseNpmPluginSource("npm:@acme/safe-plugin@latest");
    const result = await installPluginFromNpm(parsed, undefined, STAMP, {
      fetch: registryFetch(tarball),
    });

    expect(result.name).toBe("safe-plugin");
    expect(result.resolution.resolvedVersion).toBe("1.2.3");
    expect(existsSync(join(result.dir, "skills", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.dir, "SHOULD_NEVER_EXIST"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(result.dir, ".cs-meta.json"), "utf8"));
    expect(meta.source).toBe("npm:@acme/safe-plugin@1.2.3");
    expect(meta.version).toBe("1.2.3");
    expect(readInstalledPlugins().plugins["safe-plugin@local"]?.[0]?.version).toBe("1.2.3");
  });

  test("rejects a dependency-bearing package before downloading its tarball", async () => {
    const tarball = pluginTarball();
    const parsed = parseNpmPluginSource("npm:@acme/safe-plugin@1.2.3");
    let requests = 0;
    const base = registryFetch(tarball, { dependencies: { leftpad: "1.0.0" } });
    const fetch = async (...args: Parameters<typeof base>) => {
      requests += 1;
      return base(...args);
    };
    await expect(installPluginFromNpm(parsed, undefined, STAMP, { fetch })).rejects.toThrow(
      /self-contained|dependencies/,
    );
    expect(requests).toBe(1);
    expect(existsSync(join(home, ".code-shell", "plugins", "safe-plugin"))).toBe(false);
  });

  test("rejects an off-origin tarball and redirect responses", async () => {
    const tarball = pluginTarball();
    const parsed = parseNpmPluginSource("npm:@acme/safe-plugin@1.2.3");
    await expect(
      resolveNpmPlugin(parsed, {
        fetch: registryFetch(tarball, {
          dist: { tarball: "https://evil.example/plugin.tgz", integrity: integrity(tarball) },
        }),
      }),
    ).rejects.toThrow(/fixed public registry/);

    const redirect = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/metadata" },
      });
    await expect(resolveNpmPlugin(parsed, { fetch: redirect })).rejects.toThrow(/redirects/);
  });

  test("rejects integrity mismatch and tarball package identity mismatch without installing", async () => {
    const parsed = parseNpmPluginSource("npm:@acme/safe-plugin@1.2.3");
    const tarball = pluginTarball();
    await expect(
      installPluginFromNpm(parsed, undefined, STAMP, {
        fetch: registryFetch(tarball, {
          dist: {
            tarball: "https://registry.npmjs.org/@acme/safe-plugin/-/safe-plugin-1.2.3.tgz",
            integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          },
        }),
      }),
    ).rejects.toThrow(/integrity check failed/);

    const wrongIdentity = pluginTarball({ name: "@acme/other-plugin" });
    await expect(
      installPluginFromNpm(parsed, undefined, STAMP, { fetch: registryFetch(wrongIdentity) }),
    ).rejects.toThrow(/identity/);
    expect(existsSync(join(home, ".code-shell", "plugins", "safe-plugin"))).toBe(false);
  });

  test("rejects an exact-version resolution mismatch", async () => {
    const tarball = pluginTarball();
    const parsed = parseNpmPluginSource("npm:@acme/safe-plugin@1.2.3");
    await expect(
      resolveNpmPlugin(parsed, {
        fetch: registryFetch(tarball, { version: "1.2.4" }),
      }),
    ).rejects.toThrow(/different version/);
  });
});
