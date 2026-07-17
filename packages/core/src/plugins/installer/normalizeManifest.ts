import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  CANONICAL_PLUGIN_MANIFEST_FILE,
  CODESHELL_PLUGIN_OVERLAY_FILE,
  CanonicalPluginManifest,
  CodeShellPluginOverlay,
  CodexPluginManifest,
  PluginInterfaceMetadata,
  PluginAutomationsManifest,
  PluginPanelsManifest,
  type CanonicalPluginManifest as CanonicalPluginManifestData,
  type PluginPanelManifestEntry,
} from "./types.js";
import { validateSchedule } from "../../automation/scheduler.js";

export interface NormalizePluginManifestOptions {
  name: string;
  version?: string;
  format: "cc" | "codex";
  destinationRoot: string;
}

const CANONICAL_PLUGIN_ASSET_DIR = ".cs-plugin-assets";
const MAX_PLUGIN_BRAND_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_PLUGIN_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_PLUGIN_IMAGE_DIMENSION = 8192;
const MAX_PLUGIN_IMAGE_PIXELS = 40_000_000;
const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;

type RasterMediaType = "image/png" | "image/jpeg" | "image/webp";

interface ValidatedRasterAsset {
  bytes: Buffer;
  mediaType: RasterMediaType;
}

function manifestPath(sourceRoot: string, format: "cc" | "codex"): string {
  return join(sourceRoot, format === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json");
}

function isContained(root: string, candidate: string): boolean {
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(withSep);
}

function safeAuthorAssetPath(value: string, field: string): string {
  if (
    value !== value.trim() ||
    !value.startsWith("./") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error(`${field} must be a ./ relative path inside the plugin root`);
  }
  const relative = value.slice(2);
  if (
    !relative ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${field} must be a safe relative path inside the plugin root`);
  }
  return relative;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
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

function detectRaster(bytes: Buffer): {
  mediaType: RasterMediaType;
  width: number;
  height: number;
} | null {
  const png = pngDimensions(bytes);
  if (png) return { mediaType: "image/png", ...png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mediaType: "image/jpeg", ...jpeg };
  const webp = webpDimensions(bytes);
  if (webp) return { mediaType: "image/webp", ...webp };
  return null;
}

function expectedMediaType(relativePath: string): RasterMediaType | null {
  switch (extname(relativePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

async function validateRasterAsset(
  sourceRoot: string,
  sourceRootReal: string,
  declaredPath: string,
  field: string,
  maxBytes: number,
  screenshot: boolean,
): Promise<ValidatedRasterAsset> {
  const relativePath = safeAuthorAssetPath(declaredPath, field);
  if (
    screenshot &&
    (!relativePath.startsWith("assets/") || extname(relativePath).toLowerCase() !== ".png")
  ) {
    throw new Error(`${field} must be a PNG file under ./assets/`);
  }
  const expected = expectedMediaType(relativePath);
  if (!expected || (screenshot && expected !== "image/png")) {
    throw new Error(`${field} must be PNG, JPEG, or WebP`);
  }

  const candidate = resolve(sourceRoot, ...relativePath.split("/"));
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new Error(`${field} does not exist: ${declaredPath}`);
  }
  if (!isContained(sourceRootReal, target)) {
    throw new Error(`${field} escapes the plugin root: ${declaredPath}`);
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`${field} is not a file: ${declaredPath}`);
  if (info.size > maxBytes) {
    throw new Error(`${field} exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`);
  }

  const bytes = await readFile(target);
  const detected = detectRaster(bytes);
  if (!detected || detected.mediaType !== expected) {
    throw new Error(`${field} content does not match its supported raster extension`);
  }
  if (
    detected.width <= 0 ||
    detected.height <= 0 ||
    detected.width > MAX_PLUGIN_IMAGE_DIMENSION ||
    detected.height > MAX_PLUGIN_IMAGE_DIMENSION ||
    detected.width * detected.height > MAX_PLUGIN_IMAGE_PIXELS
  ) {
    throw new Error(
      `${field} dimensions exceed ${MAX_PLUGIN_IMAGE_DIMENSION}px / ${MAX_PLUGIN_IMAGE_PIXELS} pixels`,
    );
  }
  return { bytes, mediaType: detected.mediaType };
}

function canonicalAssetExtension(mediaType: RasterMediaType): string {
  if (mediaType === "image/jpeg") return "jpeg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

async function normalizeInterfaceAssets(
  sourceRoot: string,
  destinationRoot: string,
  metadata: PluginInterfaceMetadata,
): Promise<PluginInterfaceMetadata> {
  const hasDeclaredAssets =
    Boolean(metadata.composerIcon || metadata.logo || metadata.logoDark) ||
    metadata.screenshots !== undefined;
  if (!hasDeclaredAssets) return metadata;

  const sourceRootReal = await realpath(sourceRoot);
  const declared = [
    ["composerIcon", metadata.composerIcon, "composer-icon"] as const,
    ["logo", metadata.logo, "logo"] as const,
    ["logoDark", metadata.logoDark, "logo-dark"] as const,
  ];
  const brandAssets = await Promise.all(
    declared.map(async ([field, value, canonicalName]) => {
      if (!value) return null;
      const asset = await validateRasterAsset(
        sourceRoot,
        sourceRootReal,
        value,
        `interface.${field}`,
        MAX_PLUGIN_BRAND_ASSET_BYTES,
        false,
      );
      return { field, canonicalName, asset };
    }),
  );
  const screenshots = await Promise.all(
    (metadata.screenshots ?? []).map(async (value, index) => ({
      canonicalName: `screenshot-${index + 1}`,
      asset: await validateRasterAsset(
        sourceRoot,
        sourceRootReal,
        value,
        `interface.screenshots[${index}]`,
        MAX_PLUGIN_SCREENSHOT_BYTES,
        true,
      ),
    })),
  );

  const assetRoot = join(destinationRoot, CANONICAL_PLUGIN_ASSET_DIR);
  await rm(assetRoot, { recursive: true, force: true });
  const hasAssets = brandAssets.some(Boolean) || screenshots.length > 0;
  if (hasAssets) await mkdir(assetRoot, { recursive: true });

  const normalized: PluginInterfaceMetadata = { ...metadata };
  for (const entry of brandAssets) {
    if (!entry) continue;
    const relativePath = `${CANONICAL_PLUGIN_ASSET_DIR}/${entry.canonicalName}.${canonicalAssetExtension(entry.asset.mediaType)}`;
    await writeFile(join(destinationRoot, relativePath), entry.asset.bytes);
    normalized[entry.field] = relativePath;
  }
  if (metadata.screenshots !== undefined) {
    normalized.screenshots = [];
    for (const entry of screenshots) {
      const relativePath = `${CANONICAL_PLUGIN_ASSET_DIR}/${entry.canonicalName}.png`;
      await writeFile(join(destinationRoot, relativePath), entry.asset.bytes);
      normalized.screenshots.push(relativePath);
    }
  }
  return normalized;
}

async function validatePanelEntry(
  sourceRoot: string,
  entry: PluginPanelManifestEntry,
): Promise<void> {
  const root = await realpath(sourceRoot);
  const candidate = resolve(sourceRoot, ...entry.entry.split("/"));
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new Error(`panel '${entry.id}' entry does not exist: ${entry.entry}`);
  }
  if (!isContained(root, target)) {
    throw new Error(`panel '${entry.id}' entry escapes the plugin root: ${entry.entry}`);
  }
  if (!(await stat(target)).isFile()) {
    throw new Error(`panel '${entry.id}' entry is not a file: ${entry.entry}`);
  }
}

async function readCodeShellOverlay(sourceRoot: string) {
  const file = join(sourceRoot, CODESHELL_PLUGIN_OVERLAY_FILE);
  if (!existsSync(file)) return null;
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error(
      `${CODESHELL_PLUGIN_OVERLAY_FILE} must be a regular file no larger than ${MAX_PLUGIN_MANIFEST_BYTES} bytes`,
    );
  }
  return CodeShellPluginOverlay.parse(JSON.parse(await readFile(file, "utf-8")));
}

/**
 * Normalize either author manifest into the only runtime manifest Desktop may
 * consume. Invalid declared panels fail installation; plugins without panels
 * remain backward-compatible and still receive a canonical identity record.
 */
export async function normalizePluginManifest(
  sourceRoot: string,
  options: NormalizePluginManifestOptions,
): Promise<CanonicalPluginManifestData> {
  const authorPath = manifestPath(sourceRoot, options.format);
  let raw: Record<string, unknown> = {};
  if (existsSync(authorPath)) {
    const info = await stat(authorPath);
    if (!info.isFile() || info.size > MAX_PLUGIN_MANIFEST_BYTES) {
      throw new Error(
        `plugin manifest must be a regular file no larger than ${MAX_PLUGIN_MANIFEST_BYTES} bytes`,
      );
    }
    raw = JSON.parse(await readFile(authorPath, "utf-8")) as Record<string, unknown>;
  }

  const parsed =
    options.format === "codex"
      ? CodexPluginManifest.parse(raw)
      : {
          description: typeof raw.description === "string" ? raw.description : undefined,
          interface: undefined,
          panels: raw.panels === undefined ? undefined : PluginPanelsManifest.parse(raw.panels),
        };

  const overlay = await readCodeShellOverlay(sourceRoot);
  const panels = overlay?.panels ?? parsed.panels;
  for (const entry of panels?.entries ?? []) {
    await validatePanelEntry(sourceRoot, entry);
  }
  const automations = overlay?.automations
    ? PluginAutomationsManifest.parse(overlay.automations)
    : undefined;
  for (const template of automations?.templates ?? []) {
    try {
      validateSchedule(template.schedule, template.timezone);
    } catch (error) {
      throw new Error(
        `automation template '${template.id}' has an invalid schedule: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  const parsedInterface = parsed.interface
    ? PluginInterfaceMetadata.parse(parsed.interface)
    : undefined;
  const normalizedInterface = parsedInterface
    ? await normalizeInterfaceAssets(sourceRoot, options.destinationRoot, parsedInterface)
    : undefined;
  const canonical = CanonicalPluginManifest.parse({
    schemaVersion: 1,
    name: options.name,
    version: options.version ?? (typeof raw.version === "string" ? raw.version : undefined),
    description: parsed.description,
    interface: normalizedInterface,
    panels,
    automations,
  });
  await mkdir(options.destinationRoot, { recursive: true });
  await writeFile(
    join(options.destinationRoot, CANONICAL_PLUGIN_MANIFEST_FILE),
    `${JSON.stringify(canonical, null, 2)}\n`,
    "utf-8",
  );
  return canonical;
}

export async function readCanonicalPluginManifest(
  installRoot: string,
): Promise<CanonicalPluginManifestData | null> {
  const file = join(installRoot, CANONICAL_PLUGIN_MANIFEST_FILE);
  if (!existsSync(file)) return null;
  try {
    return CanonicalPluginManifest.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch {
    return null;
  }
}
