import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { officeZip as createZip } from "../../../../tests/fixtures/upload-documents.mjs";
import {
  extractZip,
  MAX_PLUGIN_ZIP_BYTES,
  MAX_PLUGIN_ZIP_ENTRIES,
  MAX_PLUGIN_ZIP_ENTRY_BYTES,
  MAX_PLUGIN_ZIP_ENTRY_NAME,
} from "../plugins/installer/unzip.js";
import { installReviewedLocalTheme, listInstalledThemes, previewLocalTheme } from "./installer.js";
import {
  ThemeInstallError,
  ThemeReviewChangedError,
  themeInstallDir,
  themesRegistryPath,
} from "./paths.js";
import { isThemePathWithinRoot, withLocalThemeSourceRoot } from "./source.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da6360000002000154a24f2f0000000049454e44ae426082",
  "hex",
);
const GIF = Buffer.from("474946383961010001000000003b", "hex");
const MANIFEST = {
  schemaVersion: 1,
  id: "zip-theme",
  name: "ZIP Theme",
  version: "1.0.0",
  surfaces: { chat: { light: "assets/chat.png", opacity: 0.25 } },
  frame: { width: 2, radius: 12 },
};
const PACK = { ".cs-theme.json": JSON.stringify(MANIFEST), "assets/chat.png": PNG };

let scratch: string;
let previousHome: string | undefined;
let previousTemporary: string[];

async function temporaryExtractions(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("cs-theme-zip-")).sort();
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "cs-theme-archive-test-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = scratch;
  previousTemporary = await temporaryExtractions();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  try {
    // Includes failures before root discovery or before the callback runs.
    expect(await temporaryExtractions()).toEqual(previousTemporary);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

async function archive(
  files: Record<string, string | Buffer> = PACK,
  name = "theme.zip",
): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, createZip(files));
  return path;
}

/** Adjust central-directory metadata without allocating a ZIP bomb's body. */
function withDeclaredSizes(bytes: Buffer, size: number): Buffer {
  const result = Buffer.from(bytes);
  let offset = result.readUInt32LE(result.length - 6);
  while (result.readUInt32LE(offset) === 0x02014b50) {
    result.writeUInt32LE(size, offset + 24);
    offset +=
      46 +
      result.readUInt16LE(offset + 28) +
      result.readUInt16LE(offset + 30) +
      result.readUInt16LE(offset + 32);
  }
  return result;
}

describe("local theme ZIP import", () => {
  test("previews and installs a ZIP with its manifest at the root", async () => {
    const path = await archive({ ...PACK, "untrusted.js": "throw new Error('never installed')" });
    const preview = await previewLocalTheme(path);
    expect(preview.id).toBe(MANIFEST.id);
    expect(preview.surfaceNames).toEqual(["chat"]);
    expect(preview.hasFrame).toBe(true);
    const installed = await installReviewedLocalTheme(path, preview.reviewToken);
    expect(installed.surfaces?.chat?.light).toBe(".cs-theme-assets/surface-chat-light.png");
    expect(
      await readFile(join(themeInstallDir(installed.id), installed.surfaces!.chat!.light!)),
    ).toEqual(PNG);
    expect((await readdir(themeInstallDir(installed.id))).sort()).toEqual([
      ".cs-theme-assets",
      ".cs-theme.json",
    ]);
    expect(await listInstalledThemes()).toEqual([installed]);
  });

  test("imports the shipped Maki pack in a wrapping folder with macOS metadata", async () => {
    const example = resolve(import.meta.dir, "../../../../examples/themes/lovelive-maki");
    const files: Record<string, Buffer> = {};
    for (const relative of [
      ".cs-theme.json",
      "README.md",
      "assets/maki-school.png",
      "assets/maki-stage.png",
    ]) {
      files[`lovelive-maki/${relative}`] = await readFile(join(example, relative));
    }
    files["__MACOSX/lovelive-maki/._.cs-theme.json"] = Buffer.from("metadata");
    files[".DS_Store"] = Buffer.from("metadata");
    files["._other/.cs-theme.json"] = Buffer.from(JSON.stringify(MANIFEST));
    const path = await archive(files, "lovelive-maki-theme.ZIP");
    const preview = await previewLocalTheme(path);
    expect(preview.id).toBe("lovelive-maki");
    expect(preview.name).toBe("西木野真姬 · Scarlet Stage");
    const installed = await installReviewedLocalTheme(path, preview.reviewToken);
    expect(installed.surfaces?.chat?.dark).toBe(".cs-theme-assets/surface-chat-dark.png");
    expect(
      await readFile(join(themeInstallDir(installed.id), installed.surfaces!.chat!.dark!)),
    ).toEqual(files["lovelive-maki/assets/maki-stage.png"]);
    expect(installed.frame).toEqual({
      ...MANIFEST.frame,
      light: "349 67% 53%",
      dark: "349 64% 47%",
    });
  });

  test("keeps directory imports compatible even when the directory ends in .zip", async () => {
    const directory = join(scratch, "folder.zip");
    await mkdir(join(directory, "assets"), { recursive: true });
    for (const [relative, bytes] of Object.entries(PACK)) {
      await writeFile(join(directory, relative), bytes);
    }
    const preview = await previewLocalTheme(directory);
    expect((await installReviewedLocalTheme(directory, preview.reviewToken)).id).toBe(MANIFEST.id);
  });

  test.each([
    ["missing", { "README.md": "No manifest" }],
    ["too-deep", { "outer/inner/.cs-theme.json": JSON.stringify(MANIFEST) }],
    [
      "ambiguous",
      {
        "first/.cs-theme.json": JSON.stringify(MANIFEST),
        "second/.cs-theme.json": JSON.stringify(MANIFEST),
      },
    ],
  ])("rejects %s theme roots and removes the extraction", async (_name, files) => {
    await expect(previewLocalTheme(await archive(files))).rejects.toBeInstanceOf(ThemeInstallError);
    expect(await listInstalledThemes()).toEqual([]);
  });

  test("rejects a damaged ZIP and removes the extraction", async () => {
    const path = join(scratch, "broken.zip");
    await writeFile(path, "not a ZIP file");
    await expect(previewLocalTheme(path)).rejects.toThrow(/cannot load theme ZIP/);
  });

  test("removes private files after successful and failed operations", async () => {
    const path = await archive();
    let root = "";
    await withLocalThemeSourceRoot(path, async (source) => {
      root = source;
      expect((await lstat(join(root, ".cs-theme.json"))).isFile()).toBe(true);
    });
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      withLocalThemeSourceRoot(path, async (source) => {
        root = source;
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cleans ZIP files when preview validation or installation fails", async () => {
    const invalid = await archive({ ".cs-theme.json": JSON.stringify(MANIFEST) }, "invalid.zip");
    await expect(previewLocalTheme(invalid)).rejects.toThrow(/asset not found/);
    const path = await archive();
    const preview = await previewLocalTheme(path);
    await mkdir(join(scratch, ".code-shell", "themes"), { recursive: true });
    await writeFile(themesRegistryPath(), "{broken");
    await expect(installReviewedLocalTheme(path, preview.reviewToken)).rejects.toThrow();
    expect(await listInstalledThemes()).toEqual([]);
  });

  test.each(["manifest", "image"])(
    "rejects changed ZIP %s content without replacing the installed theme",
    async (changed) => {
      const path = await archive();
      const firstPreview = await previewLocalTheme(path);
      const original = await installReviewedLocalTheme(path, firstPreview.reviewToken);
      const replacement = { ...MANIFEST, version: "2.0.0" };
      await archive({ ...PACK, ".cs-theme.json": JSON.stringify(replacement) });
      const preview = await previewLocalTheme(path);
      await archive({
        ...PACK,
        ".cs-theme.json": JSON.stringify(
          changed === "manifest" ? { ...replacement, name: "Changed" } : replacement,
        ),
        ...(changed === "image" ? { "assets/chat.png": GIF } : {}),
      });
      await expect(installReviewedLocalTheme(path, preview.reviewToken)).rejects.toBeInstanceOf(
        ThemeReviewChangedError,
      );
      expect(await listInstalledThemes()).toEqual([original]);
      expect(
        await readFile(join(themeInstallDir(original.id), original.surfaces!.chat!.light!)),
      ).toEqual(PNG);
    },
  );

  test.each([null, "", "bad\0.zip", "x".repeat(4097)])(
    "rejects invalid source paths %#",
    async (path) => {
      await expect(previewLocalTheme(path as string)).rejects.toBeInstanceOf(ThemeInstallError);
    },
  );

  test("rejects unsupported files and missing sources", async () => {
    const text = join(scratch, "theme.txt");
    await writeFile(text, createZip(PACK));
    await expect(previewLocalTheme(text)).rejects.toThrow(/directory or a ZIP/);
    await expect(previewLocalTheme(join(scratch, "missing.zip"))).rejects.toThrow(/not found/);
  });
});

describe("shared bounded ZIP extraction", () => {
  test.each(["../escaped.txt", "/absolute.txt", "C:/escaped.txt", "unsafe\0.txt", "unsafe\0/"])(
    "rejects unsafe ZIP entry names %# without uncaught exceptions",
    async (name) => {
      const path = await archive({ ...PACK, [name]: "unsafe" });
      const destination = join(scratch, "extracted");
      await mkdir(destination);
      await expect(extractZip(path, destination)).rejects.toThrow();
      await expect(previewLocalTheme(path)).rejects.toBeInstanceOf(ThemeInstallError);
    },
  );

  test("rejects oversized entry names", async () => {
    const path = await archive({ ["x".repeat(MAX_PLUGIN_ZIP_ENTRY_NAME + 1)]: "large name" });
    await expect(previewLocalTheme(path)).rejects.toThrow(/unsafe zip entry name/);
  });

  test("rejects an oversized ZIP before opening it", async () => {
    const path = await archive();
    await truncate(path, MAX_PLUGIN_ZIP_BYTES + 1);
    await expect(previewLocalTheme(path)).rejects.toThrow(/no larger than/);
  });

  test("rejects oversized entries and total expansion from their ZIP metadata", async () => {
    const path = join(scratch, "oversized.zip");
    await writeFile(
      path,
      withDeclaredSizes(createZip({ "large.bin": "small" }), MAX_PLUGIN_ZIP_ENTRY_BYTES + 1),
    );
    await expect(previewLocalTheme(path)).rejects.toThrow(/exceeds preview\/install limits/);
    // Directory metadata is accounted before any body is read or materialized.
    await writeFile(
      path,
      withDeclaredSizes(
        createZip({ "one/": "", "two/": "", "three/": "", "four/": "", "five/": "" }),
        MAX_PLUGIN_ZIP_ENTRY_BYTES,
      ),
    );
    await expect(previewLocalTheme(path)).rejects.toThrow(/expands beyond/);
  });

  test("rejects too many ZIP entries", async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_PLUGIN_ZIP_ENTRIES + 1 }, (_, index) => [`dir-${index}/`, ""]),
    );
    await expect(previewLocalTheme(await archive(files))).rejects.toThrow(/contains more than/);
  });
});

describe("theme asset containment across platforms", () => {
  test("accepts contained Windows assets regardless of volume casing", () => {
    expect(
      isThemePathWithinRoot("C:\\themes\\maki", "C:\\themes\\maki\\assets\\chat.png", win32),
    ).toBe(true);
    expect(
      isThemePathWithinRoot("C:\\themes\\maki", "c:\\THEMES\\maki\\assets\\chat.png", win32),
    ).toBe(true);
  });

  test.each([
    "C:\\themes\\maki-other\\chat.png",
    "C:\\themes\\chat.png",
    "D:\\themes\\maki\\chat.png",
  ])("rejects Windows assets outside the root %#", (target) => {
    expect(isThemePathWithinRoot("C:\\themes\\maki", target, win32)).toBe(false);
  });

  test("rejects Windows assets on a different network share", () => {
    expect(
      isThemePathWithinRoot("\\\\host\\share\\maki", "\\\\host\\other\\maki\\chat.png", win32),
    ).toBe(false);
  });

  test("accepts contained POSIX assets, including a filesystem root source", () => {
    expect(isThemePathWithinRoot("/themes/maki", "/themes/maki/assets/chat.png", posix)).toBe(true);
    expect(isThemePathWithinRoot("/", "/assets/chat.png", posix)).toBe(true);
    expect(isThemePathWithinRoot("/themes/maki", "/themes/maki-other/chat.png", posix)).toBe(false);
    expect(isThemePathWithinRoot("/themes/maki", "/themes/chat.png", posix)).toBe(false);
  });
});
