import { loadPluginCatalog } from "@cjhyy/code-shell-core";
import { validatePluginComposerSvg } from "@cjhyy/code-shell-core/internal";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginMediaAvailability, PluginMediaDto } from "../shared/plugin-media.js";

const MAX_BRAND_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const CANONICAL_ASSET_PATH =
  /^\.cs-plugin-assets\/(?:(?:composer-icon|logo|logo-dark|screenshot-[1-3])\.(?:png|jpeg|webp)|composer-icon\.svg)$/u;
const CANONICAL_SCREENSHOT_PATH = /^\.cs-plugin-assets\/screenshot-[1-3]\.png$/u;

interface PluginMediaManifest {
  composerIcon?: string;
  logo?: string;
  logoDark?: string;
  screenshots?: string[];
}

type RasterMediaType = "image/png" | "image/jpeg" | "image/webp";
interface RasterInfo {
  mediaType: RasterMediaType;
  width: number;
  height: number;
}

function isInside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (length < 7) return null;
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 > bytes.length
  ) {
    return null;
  }
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return {
      width: readUInt24LE(bytes, 24) + 1,
      height: readUInt24LE(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)),
    };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function detectRaster(bytes: Buffer): RasterInfo | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    return {
      mediaType: "image/png",
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mediaType: "image/jpeg", ...jpeg };
  const webp = webpDimensions(bytes);
  if (webp) return { mediaType: "image/webp", ...webp };
  return null;
}

function isBoundedRaster(info: RasterInfo): boolean {
  return (
    info.width > 0 &&
    info.height > 0 &&
    info.width <= MAX_IMAGE_DIMENSION &&
    info.height <= MAX_IMAGE_DIMENSION &&
    info.width * info.height <= MAX_IMAGE_PIXELS
  );
}

function expectedMediaType(path: string): RasterMediaType | null {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

export function pluginMediaAvailability(
  manifest: PluginMediaManifest | null | undefined,
): PluginMediaAvailability {
  return {
    composerIcon:
      typeof manifest?.composerIcon === "string" &&
      /^\.cs-plugin-assets\/composer-icon\.(?:png|jpeg|webp|svg)$/u.test(manifest.composerIcon),
    logo:
      typeof manifest?.logo === "string" &&
      /^\.cs-plugin-assets\/logo\.(?:png|jpeg|webp)$/u.test(manifest.logo),
    logoDark:
      typeof manifest?.logoDark === "string" &&
      /^\.cs-plugin-assets\/logo-dark\.(?:png|jpeg|webp)$/u.test(manifest.logoDark),
    screenshotCount: Array.isArray(manifest?.screenshots)
      ? manifest.screenshots.filter((assetPath) => CANONICAL_SCREENSHOT_PATH.test(assetPath)).length
      : 0,
  };
}

/** Defense-in-depth read of one installer-normalized asset. */
export function readCanonicalPluginAssetDataUrl(
  installPath: string,
  assetPath: string | undefined,
  maxBytes: number,
): string | undefined {
  try {
    if (
      typeof assetPath !== "string" ||
      !CANONICAL_ASSET_PATH.test(assetPath) ||
      isAbsolute(assetPath)
    ) {
      return undefined;
    }
    const rootReal = realpathSync(installPath);
    const candidate = resolve(installPath, ...assetPath.split("/"));
    const entry = lstatSync(candidate);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > maxBytes) return undefined;
    const targetReal = realpathSync(candidate);
    if (!isInside(targetReal, rootReal)) return undefined;
    const info = statSync(targetReal);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    // Bind the bounded read to the checked regular leaf. O_NOFOLLOW prevents
    // a leaf swap on supporting platforms; identity checks also bind the
    // descriptor to the containment check. This is not an OS sandbox.
    const fd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.size > maxBytes ||
        opened.dev !== entry.dev ||
        opened.ino !== entry.ino ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino
      )
        return undefined;
      const openedTarget = realpathSync(candidate);
      if (!isInside(openedTarget, rootReal)) return undefined;
      const current = statSync(openedTarget);
      if (current.dev !== opened.dev || current.ino !== opened.ino) return undefined;
      const buffer = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      const after = fstatSync(fd);
      if (
        length !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        return undefined;
      bytes = buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
    if (bytes.length > maxBytes) return undefined;
    if (assetPath === ".cs-plugin-assets/composer-icon.svg") {
      validatePluginComposerSvg(bytes);
      return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
    }
    const raster = detectRaster(bytes);
    if (!raster || !isBoundedRaster(raster) || raster.mediaType !== expectedMediaType(assetPath)) {
      return undefined;
    }
    return `data:${raster.mediaType};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export function readPluginMediaFromManifest(
  installPath: string,
  manifest: PluginMediaManifest | null | undefined,
  includeScreenshots = false,
): PluginMediaDto {
  // A modified manifest cannot borrow the valid composer SVG path for a raster
  // DTO slot. The generic canonical reader still validates actual SVG bytes.
  const rasterBrand = (assetPath: string | undefined) =>
    assetPath === ".cs-plugin-assets/composer-icon.svg"
      ? undefined
      : readCanonicalPluginAssetDataUrl(installPath, assetPath, MAX_BRAND_ASSET_BYTES);
  return {
    composerIconDataUrl: readCanonicalPluginAssetDataUrl(
      installPath,
      manifest?.composerIcon,
      MAX_BRAND_ASSET_BYTES,
    ),
    logoDataUrl: rasterBrand(manifest?.logo),
    logoDarkDataUrl: rasterBrand(manifest?.logoDark),
    screenshotDataUrls: includeScreenshots
      ? (manifest?.screenshots ?? [])
          .filter((assetPath) => CANONICAL_SCREENSHOT_PATH.test(assetPath))
          .slice(0, 3)
          .map((assetPath) =>
            readCanonicalPluginAssetDataUrl(installPath, assetPath, MAX_SCREENSHOT_BYTES),
          )
          .filter((value): value is string => typeof value === "string")
      : [],
  };
}

export function getPluginMedia(
  installKey: string,
  includeScreenshots = false,
): PluginMediaDto | null {
  try {
    const plugin = loadPluginCatalog().find((entry) => entry.installKey === installKey);
    if (!plugin) return null;
    return readPluginMediaFromManifest(
      plugin.installPath,
      plugin.manifest?.interface,
      includeScreenshots,
    );
  } catch {
    return null;
  }
}
