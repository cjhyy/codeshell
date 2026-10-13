import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectThemeImage } from "./image.js";
import { THEME_SURFACE_NAMES, parseThemeManifest } from "./manifest.js";
import {
  installReviewedLocalTheme,
  listInstalledThemes,
  previewLocalTheme,
  uninstallTheme,
} from "./installer.js";
import {
  THEME_ASSET_DIR,
  ThemeReviewChangedError,
  themeInstallDir,
  themesRegistryPath,
} from "./paths.js";

const INSTALLER_MODULE = join(import.meta.dir, "installer.ts");

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

  test.each([
    "../x.png",
    "/tmp/x.png",
    "a/../../x.png",
    "a\\x.png",
    "x\0.png",
    "https://example.com/x.png",
  ])("rejects unsafe surface image path %s", (path) => {
    expect(() =>
      parseThemeManifest({ ...FULL_MANIFEST, surfaces: { chat: { light: path } } }),
    ).toThrow();
  });

  test.each([
    { opacity: -0.1 },
    { opacity: 1.1 },
    { backgroundOpacity: -1 },
    { backgroundOpacity: 2 },
    { fit: "repeat" },
    { position: "calc(1px + 1%)" },
    { background: { light: "red" } },
    { background: { dark: "0 0% 0%; background: url(https://example.com)" } },
    { background: { contrast: "0 0% 0%" } },
    { css: "position: fixed" },
  ])("rejects invalid surface appearance %j", (surface) => {
    expect(() => parseThemeManifest({ ...FULL_MANIFEST, surfaces: { chat: surface } })).toThrow();
  });

  test.each([
    { width: -1 },
    { width: 9 },
    { radius: -1 },
    { radius: 25 },
    { light: "url(https://example.com)" },
    { style: "border-image: url(https://example.com)" },
  ])("rejects invalid frame appearance %j", (frame) => {
    expect(() => parseThemeManifest({ ...FULL_MANIFEST, frame })).toThrow();
  });

  test("rejects unknown surface names", () => {
    expect(() => parseThemeManifest({ ...FULL_MANIFEST, surfaces: { unknown: {} } })).toThrow();
  });
});

describe("theme installer", () => {
  test("roundtrips every surface image and preserves appearance controls and frame", async () => {
    const surfaces = Object.fromEntries(
      THEME_SURFACE_NAMES.map((name) => [
        name,
        {
          light: `images/${name}.png`,
          dark: `images/${name}.gif`,
          opacity: 0,
          fit: "contain",
          position: "bottom-right",
          background: { light: "350 60% 98%", dark: "350 25% 12%" },
          backgroundOpacity: 0.75,
        },
      ]),
    );
    const frame = { light: "350 70% 50%", dark: "350 60% 65%", width: 2.5, radius: 18 };
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "all-surfaces",
        name: "All Surfaces",
        version: "1",
        surfaces,
        frame,
      }),
      ...Object.fromEntries(
        THEME_SURFACE_NAMES.flatMap((name) => [
          [`images/${name}.png`, PNG_1x1],
          [`images/${name}.gif`, GIF_1x1],
        ]),
      ),
    });
    const preview = await previewLocalTheme(src);
    expect(preview.surfaceNames).toEqual([...THEME_SURFACE_NAMES]);
    expect(preview.warnings).toEqual([]);
    const installed = await installReviewedLocalTheme(src, preview.reviewToken);
    expect(installed.frame).toEqual(frame);
    for (const name of THEME_SURFACE_NAMES) {
      const light = `${THEME_ASSET_DIR}/surface-${name}-light.png`;
      const dark = `${THEME_ASSET_DIR}/surface-${name}-dark.gif`;
      expect(installed.surfaces?.[name]).toEqual({ ...surfaces[name], light, dark });
      expect(await readFile(join(themeInstallDir(installed.id), light))).toEqual(PNG_1x1);
      expect(await readFile(join(themeInstallDir(installed.id), dark))).toEqual(GIF_1x1);
    }
    const onDisk = parseThemeManifest(
      JSON.parse(await readFile(join(themeInstallDir(installed.id), ".cs-theme.json"), "utf8")),
    );
    expect(onDisk.surfaces).toEqual(installed.surfaces);
    expect(onDisk.frame).toEqual(frame);
    expect(await listInstalledThemes()).toEqual([installed]);
  });

  test("retains image-free surface controls and zero-valued frame settings", async () => {
    const surfaces = { chat: { background: { light: "0 0% 100%" }, backgroundOpacity: 0 } };
    const frame = { width: 0, radius: 0 };
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "surfaces-only",
        name: "Surfaces Only",
        version: "1",
        surfaces,
        frame,
      }),
    });
    const preview = await previewLocalTheme(src);
    expect(preview.surfaceNames).toEqual(["chat"]);
    expect(preview.hasFrame).toBe(true);
    expect(preview.warnings).toEqual([]);
    const installed = await installReviewedLocalTheme(src, preview.reviewToken);
    expect(installed.surfaces).toEqual(surfaces);
    expect(installed.frame).toEqual(frame);
    expect(await listInstalledThemes()).toEqual([installed]);
  });

  test("identifies frame-only contents without reporting an empty frame", async () => {
    const manifest = {
      schemaVersion: 1,
      id: "frame-only",
      name: "Frame Only",
      version: "1",
      frame: { width: 0, radius: 0 },
    };
    const src = await writePack({ ".cs-theme.json": JSON.stringify(manifest) });
    const preview = await previewLocalTheme(src);
    expect(preview.hasFrame).toBe(true);
    expect(preview.surfaceNames).toBeUndefined();
    expect(preview.warnings).toEqual([]);
    await writeFile(join(src, ".cs-theme.json"), JSON.stringify({ ...manifest, frame: {} }));
    expect((await previewLocalTheme(src)).hasFrame).toBeUndefined();
  });

  test("surface image content is bound to the review token", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "surface-review",
        name: "Surface Review",
        version: "1",
        surfaces: { chat: { dark: "chat.png", opacity: 0.25 } },
      }),
      "chat.png": PNG_1x1,
    });
    const preview = await previewLocalTheme(src);
    // A valid replacement image still requires a new review.
    await writeFile(join(src, "chat.png"), GIF_1x1);
    await expect(installReviewedLocalTheme(src, preview.reviewToken)).rejects.toBeInstanceOf(
      ThemeReviewChangedError,
    );
    expect(await listInstalledThemes()).toEqual([]);
  });

  test("surface and frame appearance changes require a new review", async () => {
    const manifest = {
      schemaVersion: 1,
      id: "appearance-review",
      name: "Appearance Review",
      version: "1",
      surfaces: { chat: { backgroundOpacity: 0.9 } },
      frame: { width: 2 },
    };
    const src = await writePack({ ".cs-theme.json": JSON.stringify(manifest) });
    const preview = await previewLocalTheme(src);
    await writeFile(
      join(src, ".cs-theme.json"),
      JSON.stringify({ ...manifest, surfaces: { chat: { backgroundOpacity: 0.5 } } }),
    );
    await expect(installReviewedLocalTheme(src, preview.reviewToken)).rejects.toBeInstanceOf(
      ThemeReviewChangedError,
    );
    await writeFile(
      join(src, ".cs-theme.json"),
      JSON.stringify({ ...manifest, frame: { width: 3 } }),
    );
    await expect(installReviewedLocalTheme(src, preview.reviewToken)).rejects.toBeInstanceOf(
      ThemeReviewChangedError,
    );
  });

  test("surface assets use the existing image and symlink safeguards", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "unsafe-surface",
        name: "Unsafe Surface",
        version: "1",
        surfaces: { window: { light: "window.png" } },
      }),
      "window.png": "<svg onload='alert(1)'/>",
    });
    await expect(previewLocalTheme(src)).rejects.toThrow(/not a supported image/);
    const outside = join(home, "outside.png");
    await writeFile(outside, PNG_1x1);
    await rm(join(src, "window.png"));
    await symlink(outside, join(src, "window.png"));
    await expect(previewLocalTheme(src)).rejects.toThrow(/escapes theme root/);
  });

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

  test("a corrupt registry cannot delete an installed theme during uninstall", async () => {
    const src = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "atomic-uninstall",
        name: "Atomic Uninstall",
        version: "1",
        colors: { light: { "--cs-primary": "210 80% 45%" } },
      }),
    });
    const preview = await previewLocalTheme(src);
    await installReviewedLocalTheme(src, preview.reviewToken);
    const manifestPath = join(themeInstallDir("atomic-uninstall"), ".cs-theme.json");
    const before = await readFile(manifestPath, "utf8");
    await writeFile(themesRegistryPath(), "{broken");

    await expect(uninstallTheme("atomic-uninstall")).rejects.toThrow();
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  test("a corrupt registry cannot replace an existing theme", async () => {
    const original = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "atomic-replace",
        name: "Original",
        version: "1",
        colors: { light: { "--cs-primary": "210 80% 45%" } },
      }),
    });
    let preview = await previewLocalTheme(original);
    await installReviewedLocalTheme(original, preview.reviewToken);
    const manifestPath = join(themeInstallDir("atomic-replace"), ".cs-theme.json");
    const before = await readFile(manifestPath, "utf8");

    const replacement = await writePack({
      ".cs-theme.json": JSON.stringify({
        schemaVersion: 1,
        id: "atomic-replace",
        name: "Replacement",
        version: "2",
        colors: { light: { "--cs-primary": "310 80% 50%" } },
      }),
    });
    preview = await previewLocalTheme(replacement);
    await writeFile(themesRegistryPath(), "{broken");

    await expect(installReviewedLocalTheme(replacement, preview.reviewToken)).rejects.toThrow();
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  test("does not follow a linked manifest outside the reviewed pack", async () => {
    const src = await writePack({ ".cs-theme.json": JSON.stringify(FULL_MANIFEST) });
    const outside = join(home, "outside-theme.json");
    await writeFile(outside, JSON.stringify({ ...FULL_MANIFEST, name: "Outside" }));
    await rm(join(src, ".cs-theme.json"));
    await symlink(outside, join(src, ".cs-theme.json"));
    await expect(previewLocalTheme(src)).rejects.toThrow();
  });

  test("concurrent theme installs preserve every registry entry", async () => {
    const total = 8;
    const sources = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        writePack({
          ".cs-theme.json": JSON.stringify({
            schemaVersion: 1,
            id: `concurrent-${index}`,
            name: `Concurrent ${index}`,
            version: "1",
            colors: { light: { "--cs-primary": "210 80% 45%" } },
          }),
        }),
      ),
    );
    const children = sources.map((source) => {
      const script = `
        import { previewLocalTheme, installReviewedLocalTheme } from ${JSON.stringify(INSTALLER_MODULE)};
        const preview = await previewLocalTheme(${JSON.stringify(source)});
        await installReviewedLocalTheme(${JSON.stringify(source)}, preview.reviewToken);
      `;
      return Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, CODE_SHELL_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    expect(
      (await Promise.all(children.map((child) => child.exited))).every((code) => code === 0),
    ).toBe(true);
    expect((await listInstalledThemes()).map((theme) => theme.id).sort()).toEqual(
      Array.from({ length: total }, (_, index) => `concurrent-${index}`).sort(),
    );
  }, 60_000);
});

describe("themesRoot refuses the real home from a test", () => {
  let prevHome: string | undefined;
  let prevNodeEnv: string | undefined;
  beforeEach(() => {
    prevHome = process.env.CODE_SHELL_HOME;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.CODE_SHELL_HOME;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevHome;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  test("throws rather than installing into ~/.code-shell/themes", async () => {
    // This is not hypothetical: eight "concurrent-N" fixture themes reached a
    // real machine's theme picker on 2026-09-06 and the user asked why their
    // settings were full of strange packs. themesRoot resolved HOME on its own
    // instead of going through codeShellHome(), so the sessions-root guard did
    // not cover it.
    process.env.NODE_ENV = "test";
    const { themesRoot } = await import("./paths.js");
    expect(() => themesRoot()).toThrow(/CODE_SHELL_HOME/);
  });

  test("an explicit CODE_SHELL_HOME is honoured", async () => {
    process.env.NODE_ENV = "test";
    process.env.CODE_SHELL_HOME = "/tmp/cs-theme-home";
    const { themesRoot } = await import("./paths.js");
    expect(themesRoot()).toBe("/tmp/cs-theme-home/.code-shell/themes");
  });

  test("a real host run still resolves the real home", async () => {
    process.env.NODE_ENV = "production";
    const { themesRoot } = await import("./paths.js");
    expect(themesRoot()).toContain(".code-shell");
  });
});
