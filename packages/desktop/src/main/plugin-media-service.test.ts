import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginMediaAvailability,
  readCanonicalPluginAssetDataUrl,
  readPluginMediaFromManifest,
} from "./plugin-media-service";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

describe("desktop plugin media service", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function pluginRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-media-"));
    roots.push(root);
    mkdirSync(join(root, ".cs-plugin-assets"), { recursive: true });
    return root;
  }

  test("returns bounded data URLs without exposing canonical file paths", () => {
    const root = pluginRoot();
    writeFileSync(join(root, ".cs-plugin-assets", "logo.png"), PNG);
    writeFileSync(join(root, ".cs-plugin-assets", "screenshot-1.png"), PNG);

    const media = readPluginMediaFromManifest(
      root,
      {
        logo: ".cs-plugin-assets/logo.png",
        screenshots: [".cs-plugin-assets/screenshot-1.png"],
      },
      true,
    );
    expect(media.logoDataUrl).toStartWith("data:image/png;base64,");
    expect(media.screenshotDataUrls).toHaveLength(1);
    expect(JSON.stringify(media)).not.toContain(root);
    expect(JSON.stringify(media)).not.toContain(".cs-plugin-assets");
  });

  test("rejects traversal, escaping symlinks, unsupported bytes, and post-install growth", () => {
    const root = pluginRoot();
    const outside = mkdtempSync(join(tmpdir(), "cs-plugin-media-out-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.png"), PNG);
    symlinkSync(join(outside, "secret.png"), join(root, ".cs-plugin-assets", "logo.png"));
    expect(
      readCanonicalPluginAssetDataUrl(root, ".cs-plugin-assets/logo.png", 1024),
    ).toBeUndefined();
    expect(readCanonicalPluginAssetDataUrl(root, "../../secret.png", 1024)).toBeUndefined();

    rmSync(join(root, ".cs-plugin-assets", "logo.png"));
    writeFileSync(join(root, ".cs-plugin-assets", "logo.png"), "<svg/>");
    expect(
      readCanonicalPluginAssetDataUrl(root, ".cs-plugin-assets/logo.png", 1024),
    ).toBeUndefined();

    writeFileSync(join(root, ".cs-plugin-assets", "logo.png"), PNG);
    truncateSync(join(root, ".cs-plugin-assets", "logo.png"), 1025);
    expect(
      readCanonicalPluginAssetDataUrl(root, ".cs-plugin-assets/logo.png", 1024),
    ).toBeUndefined();

    const bomb = Buffer.from(PNG);
    bomb.writeUInt32BE(9000, 16);
    writeFileSync(join(root, ".cs-plugin-assets", "logo.png"), bomb);
    expect(
      readCanonicalPluginAssetDataUrl(root, ".cs-plugin-assets/logo.png", 2048),
    ).toBeUndefined();
  });

  test("summarizes declared media without returning paths", () => {
    expect(
      pluginMediaAvailability({
        composerIcon: ".cs-plugin-assets/composer-icon.png",
        logo: ".cs-plugin-assets/logo.png",
        logoDark: ".cs-plugin-assets/logo-dark.png",
        screenshots: [".cs-plugin-assets/screenshot-1.png", ".cs-plugin-assets/screenshot-2.png"],
      }),
    ).toEqual({
      composerIcon: true,
      logo: true,
      logoDark: true,
      screenshotCount: 2,
    });
  });
});
