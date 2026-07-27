import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectThemeImage } from "./image.js";
import { parseThemeManifest } from "./manifest.js";
import {
  installReviewedLocalTheme,
  listInstalledThemes,
  previewLocalTheme,
  uninstallTheme,
} from "./installer.js";
import { THEME_ASSET_DIR, ThemeReviewChangedError } from "./paths.js";

// A minimal valid 1x1 PNG.
const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da6360000002000154a24f2f0000000049454e44ae426082",
  "hex",
);
// GIF89a 1x1 (animated-capable format) — header + logical screen 1x1.
const GIF_1x1 = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]),
]);

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cs-themes-home-"));
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

async function writePack(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cs-theme-src-"));
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, data);
  }
  return dir;
}

const FULL_MANIFEST = {
  schemaVersion: 1,
  id: "acme-neon",
  name: "Acme Neon",
  version: "1.0.0",
  colors: {
    light: { "--cs-primary": "310 80% 50%", "--cs-ring": "310 80% 50%" },
    dark: { "--cs-primary": "310 85% 65%" },
  },
  pet: { idle: "idle.png", running: "run.gif" },
  wallpaper: { light: "bg.png", opacity: 0.2 },
};

describe("detectThemeImage", () => {
  test("accepts png and (animated-capable) gif, rejects non-images", () => {
    expect(detectThemeImage(PNG_1x1)?.mediaType).toBe("image/png");
    expect(detectThemeImage(GIF_1x1)?.mediaType).toBe("image/gif");
    expect(detectThemeImage(Buffer.from("not an image"))).toBeNull();
  });
});

describe("parseThemeManifest", () => {
  test("rejects unknown css variables and bad ids", () => {
    expect(() =>
      parseThemeManifest({ ...FULL_MANIFEST, colors: { light: { "--evil": "1 2% 3%" } } }),
    ).toThrow();
    expect(() => parseThemeManifest({ ...FULL_MANIFEST, id: "../escape" })).toThrow();
    expect(() =>
      parseThemeManifest({ ...FULL_MANIFEST, colors: { light: { "--cs-primary": "red" } } }),
    ).toThrow();
  });
  test("rejects traversal in asset paths", () => {
    expect(() => parseThemeManifest({ ...FULL_MANIFEST, pet: { idle: "../x.png" } })).toThrow();
  });
});

describe("theme installer", () => {
  test("previews, installs, lists, and uninstalls a full pack", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify(FULL_MANIFEST),
      "idle.png": PNG_1x1,
      "run.gif": GIF_1x1,
      "bg.png": PNG_1x1,
    });

    const preview = await previewLocalTheme(src);
    expect(preview.id).toBe("acme-neon");
    expect(preview.hasColors).toBe(true);
    expect(preview.petStates.sort()).toEqual(["idle", "running"]);
    expect(preview.wallpaperModes).toEqual(["light"]);
    expect(preview.swatch).toBe("310 80% 50%");

    const installed = await installReviewedLocalTheme(src, preview.reviewToken);
    // Assets renamed to canonical names by true extension (gif stays gif).
    expect(installed.pet.idle).toBe(`${THEME_ASSET_DIR}/pet-idle.png`);
    expect(installed.pet.running).toBe(`${THEME_ASSET_DIR}/pet-running.gif`);
    expect(installed.wallpaper?.light).toBe(`${THEME_ASSET_DIR}/wallpaper-light.png`);
    expect(installed.wallpaper?.opacity).toBe(0.2);
    expect(installed.colors.light["--cs-primary"]).toBe("310 80% 50%");

    // Persisted manifest points at canonical assets, and the bytes exist.
    const onDisk = JSON.parse(
      await readFile(join(home, ".code-shell", "themes", "acme-neon", ".cs-theme.json"), "utf-8"),
    );
    expect(onDisk.pet.running).toBe(`${THEME_ASSET_DIR}/pet-running.gif`);
    await readFile(
      join(home, ".code-shell", "themes", "acme-neon", THEME_ASSET_DIR, "pet-running.gif"),
    );

    const list = await listInstalledThemes();
    expect(list.map((t) => t.id)).toEqual(["acme-neon"]);

    await uninstallTheme("acme-neon");
    expect(await listInstalledThemes()).toEqual([]);
  });

  test("install rejects a mismatched review token (content changed mid-review)", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({ ...FULL_MANIFEST, pet: undefined, wallpaper: undefined }),
    });
    const preview = await previewLocalTheme(src);
    // Tamper with the manifest after preview.
    await writeFile(
      join(src, ".cs-theme.json"),
      JSON.stringify({ ...FULL_MANIFEST, pet: undefined, wallpaper: undefined, name: "Changed" }),
    );
    await expect(installReviewedLocalTheme(src, preview.reviewToken)).rejects.toBeInstanceOf(
      ThemeReviewChangedError,
    );
  });

  test("preview fails when a declared asset is missing or not an image", async () => {
    const missing = await writePack({ ".cs-theme.json": JSON.stringify(FULL_MANIFEST) });
    await expect(previewLocalTheme(missing)).rejects.toThrow();

    const notImage = await writePack({
      ".cs-theme.json": JSON.stringify({
        ...FULL_MANIFEST,
        wallpaper: undefined,
        pet: { idle: "idle.png" },
      }),
      "idle.png": Buffer.from("totally not a png"),
    });
    await expect(previewLocalTheme(notImage)).rejects.toThrow();
  });

  test("normalizes walk frames to ordered canonical names", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "runner",
        name: "Runner",
        version: "1",
        pet: { idle: "i.png", walk: ["a.png", "b.gif", "c.png"] },
      }),
      "i.png": PNG_1x1,
      "a.png": PNG_1x1,
      "b.gif": GIF_1x1,
      "c.png": PNG_1x1,
    });
    const preview = await previewLocalTheme(src);
    const installed = await installReviewedLocalTheme(src, preview.reviewToken);
    expect(installed.pet.walk).toEqual([
      `${THEME_ASSET_DIR}/pet-walk-1.png`,
      `${THEME_ASSET_DIR}/pet-walk-2.gif`,
      `${THEME_ASSET_DIR}/pet-walk-3.png`,
    ]);
  });

  test("rejects an asset that is a symlink escaping the pack root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cs-theme-outside-"));
    await writeFile(join(outside, "secret.png"), PNG_1x1);
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "sneaky",
        name: "Sneaky",
        version: "1",
        pet: { idle: "idle.png" },
      }),
    });
    // idle.png is a symlink to a file outside the pack (a valid image, so the
    // magic-number check alone would pass — only the realpath guard stops it).
    await symlink(join(outside, "secret.png"), join(src, "idle.png"));
    await expect(previewLocalTheme(src)).rejects.toThrow(/escapes theme root/);
    await rm(outside, { recursive: true, force: true });
  });

  test("a colors-only pack installs with empty pet/wallpaper", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "just-blue",
        name: "Just Blue",
        version: "1",
        colors: { light: { "--cs-primary": "210 80% 45%" }, dark: {} },
      }),
    });
    const preview = await previewLocalTheme(src);
    expect(preview.petStates).toEqual([]);
    const installed = await installReviewedLocalTheme(src, preview.reviewToken);
    expect(installed.pet).toEqual({});
    expect(installed.wallpaper).toBeUndefined();
  });
});
