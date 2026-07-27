/**
 * Theme-pack installer: validate → normalize → atomically install a local theme
 * pack into ~/.code-shell/themes/<id>/, and read/uninstall installed packs.
 *
 * Mirrors the plugin installer's discipline (safe names, canonical asset paths,
 * review-token double-check, temp-dir + rename atomicity) but is deliberately
 * self-contained and static-only: a theme pack is a manifest + images, never
 * executable content, so there are no hooks/mcp/skills to approve.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { detectThemeImage } from "./image.js";
import { parseThemeManifest, type ThemeManifest } from "./manifest.js";
import {
  THEME_ASSET_DIR,
  ThemeInstallError,
  ThemeReviewChangedError,
  assertSafeThemeName,
  themeInstallDir,
  themesRegistryPath,
  themesRoot,
} from "./paths.js";

const MANIFEST_FILE = ".cs-theme.json";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
type PetState = "idle" | "running" | "alert";
type WallpaperMode = "light" | "dark";

/** One resolved asset: where the author put it → the canonical name we store. */
interface ResolvedAsset {
  sourceRel: string;
  canonicalName: string; // e.g. "pet-idle.webp"
}

export interface ThemePreview {
  id: string;
  name: string;
  version: string;
  hasColors: boolean;
  petStates: PetState[];
  wallpaperModes: WallpaperMode[];
  /** The pack's primary color (for the picker swatch), if it overrides one. */
  swatch?: string;
  /** Content digest bound to a subsequent install to detect mid-review changes. */
  reviewToken: string;
  warnings: string[];
}

/** An installed theme as the host exposes it to the renderer. */
export interface InstalledTheme {
  id: string;
  name: string;
  version: string;
  colors: { light: Record<string, string>; dark: Record<string, string> };
  pet: Partial<Record<PetState, string>> & { walk?: string[] }; // canonical relative asset paths
  wallpaper?: { light?: string; dark?: string; opacity?: number };
}

interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  installedAt: number;
}
interface Registry {
  version: 1;
  themes: RegistryEntry[];
}

async function readImageAsset(
  sourceDir: string,
  rel: string,
): Promise<{ bytes: Buffer; ext: string }> {
  const abs = resolve(sourceDir, rel);
  if (!abs.startsWith(resolve(sourceDir) + "/") && abs !== resolve(sourceDir)) {
    throw new ThemeInstallError(`asset escapes theme root: ${rel}`);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(abs);
  } catch {
    throw new ThemeInstallError(`asset not found: ${rel}`);
  }
  if (!info.isFile()) throw new ThemeInstallError(`asset is not a file: ${rel}`);
  if (info.size > MAX_ASSET_BYTES) throw new ThemeInstallError(`asset too large: ${rel}`);
  const bytes = await readFile(abs);
  const detected = detectThemeImage(bytes);
  if (!detected) throw new ThemeInstallError(`asset is not a supported image: ${rel}`);
  return { bytes, ext: detected.ext };
}

/** Collect the declared assets, validating each, into canonical-name mappings. */
async function resolveAssets(
  sourceDir: string,
  manifest: ThemeManifest,
): Promise<{ assets: ResolvedAsset[]; bytesByName: Map<string, Buffer> }> {
  const assets: ResolvedAsset[] = [];
  const bytesByName = new Map<string, Buffer>();
  const add = async (rel: string | undefined, base: string): Promise<void> => {
    if (!rel) return;
    const { bytes, ext } = await readImageAsset(sourceDir, rel);
    const canonicalName = `${base}.${ext}`;
    assets.push({ sourceRel: rel, canonicalName });
    bytesByName.set(canonicalName, bytes);
  };
  await add(manifest.pet?.idle, "pet-idle");
  await add(manifest.pet?.running, "pet-running");
  await add(manifest.pet?.alert, "pet-alert");
  for (let i = 0; i < (manifest.pet?.walk?.length ?? 0); i += 1) {
    await add(manifest.pet!.walk![i], `pet-walk-${i + 1}`);
  }
  await add(manifest.wallpaper?.light, "wallpaper-light");
  await add(manifest.wallpaper?.dark, "wallpaper-dark");
  return { assets, bytesByName };
}

/** Deterministic digest over manifest + every canonical asset's bytes. */
function digestProjection(manifest: ThemeManifest, bytesByName: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(manifest));
  for (const name of [...bytesByName.keys()].sort()) {
    hash.update(name);
    hash.update(bytesByName.get(name)!);
  }
  return hash.digest("hex");
}

async function loadManifest(sourceDir: string): Promise<ThemeManifest> {
  let raw: string;
  try {
    raw = await readFile(join(sourceDir, MANIFEST_FILE), "utf-8");
  } catch {
    throw new ThemeInstallError(`missing ${MANIFEST_FILE}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ThemeInstallError(`${MANIFEST_FILE} is not valid JSON`);
  }
  return parseThemeManifest(json);
}

function previewOf(
  manifest: ThemeManifest,
  bytesByName: Map<string, Buffer>,
  warnings: string[],
): ThemePreview {
  const petStates = (["idle", "running", "alert"] as const).filter((s) => manifest.pet?.[s]);
  const wallpaperModes = (["light", "dark"] as const).filter((m) => manifest.wallpaper?.[m]);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    hasColors: Boolean(
      (manifest.colors?.light && Object.keys(manifest.colors.light).length) ||
      (manifest.colors?.dark && Object.keys(manifest.colors.dark).length),
    ),
    petStates: [...petStates],
    wallpaperModes: [...wallpaperModes],
    ...((manifest.colors?.light?.["--cs-primary"] ?? manifest.colors?.dark?.["--cs-primary"])
      ? {
          swatch: (manifest.colors?.light?.["--cs-primary"] ??
            manifest.colors?.dark?.["--cs-primary"])!,
        }
      : {}),
    reviewToken: digestProjection(manifest, bytesByName),
    warnings,
  };
}

/**
 * Validate a theme pack directory and return a preview + review-token. Does not
 * write anything. `sourceDir` is a directory (a zip is extracted to a temp dir
 * by the caller before calling this).
 */
export async function previewLocalTheme(sourceDir: string): Promise<ThemePreview> {
  const manifest = await loadManifest(sourceDir);
  assertSafeThemeName(manifest.id);
  const warnings: string[] = [];
  if (!manifest.colors && !manifest.pet && !manifest.wallpaper) {
    warnings.push("theme declares no colors, pet sprites, or wallpaper");
  }
  const { bytesByName } = await resolveAssets(sourceDir, manifest);
  return previewOf(manifest, bytesByName, warnings);
}

/**
 * Install a previously previewed theme. Re-validates and re-checks the token
 * (rejecting mid-review changes), then atomically writes the theme to
 * ~/.code-shell/themes/<id>/ and records it in the registry.
 */
export async function installReviewedLocalTheme(
  sourceDir: string,
  reviewToken: string,
): Promise<InstalledTheme> {
  const manifest = await loadManifest(sourceDir);
  assertSafeThemeName(manifest.id);
  const { assets, bytesByName } = await resolveAssets(sourceDir, manifest);
  if (digestProjection(manifest, bytesByName) !== reviewToken) throw new ThemeReviewChangedError();

  const finalDir = themeInstallDir(manifest.id);
  await mkdir(themesRoot(), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(themesRoot(), `.tmp-${manifest.id}-`));
  try {
    // Rewrite the manifest to canonical asset paths, then stage assets.
    const canonical = canonicalManifestFor(manifest, assets);
    await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(canonical, null, 2)}\n`, {
      mode: 0o600,
    });
    await mkdir(join(staging, THEME_ASSET_DIR), { recursive: true, mode: 0o700 });
    for (const asset of assets) {
      await writeFile(
        join(staging, THEME_ASSET_DIR, asset.canonicalName),
        bytesByName.get(asset.canonicalName)!,
        {
          mode: 0o600,
        },
      );
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(staging, finalDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  await appendRegistryEntry({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    installedAt: Date.now(),
  });
  return toInstalledTheme(canonicalManifestFor(manifest, assets));
}

/** Canonical manifest stored on disk: asset fields point at THEME_ASSET_DIR/*. */
function canonicalManifestFor(manifest: ThemeManifest, assets: ResolvedAsset[]): ThemeManifest {
  const nameFor = (base: string): string | undefined =>
    assets.find((a) => a.canonicalName.startsWith(`${base}.`))?.canonicalName;
  const rel = (base: string): string | undefined => {
    const n = nameFor(base);
    return n ? `${THEME_ASSET_DIR}/${n}` : undefined;
  };
  const walk = (manifest.pet?.walk ?? [])
    .map((_, i) => rel(`pet-walk-${i + 1}`))
    .filter((p): p is string => Boolean(p));
  const pet = manifest.pet
    ? {
        ...(rel("pet-idle") ? { idle: rel("pet-idle") } : {}),
        ...(rel("pet-running") ? { running: rel("pet-running") } : {}),
        ...(rel("pet-alert") ? { alert: rel("pet-alert") } : {}),
        ...(walk.length ? { walk } : {}),
      }
    : undefined;
  const wallpaper = manifest.wallpaper
    ? {
        ...(rel("wallpaper-light") ? { light: rel("wallpaper-light") } : {}),
        ...(rel("wallpaper-dark") ? { dark: rel("wallpaper-dark") } : {}),
        ...(manifest.wallpaper.opacity !== undefined
          ? { opacity: manifest.wallpaper.opacity }
          : {}),
      }
    : undefined;
  return {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.colors ? { colors: manifest.colors } : {}),
    ...(pet && Object.keys(pet).length ? { pet } : {}),
    ...(wallpaper && Object.keys(wallpaper).length ? { wallpaper } : {}),
  };
}

function toInstalledTheme(manifest: ThemeManifest): InstalledTheme {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    colors: { light: manifest.colors?.light ?? {}, dark: manifest.colors?.dark ?? {} },
    pet: {
      ...(manifest.pet?.idle ? { idle: manifest.pet.idle } : {}),
      ...(manifest.pet?.running ? { running: manifest.pet.running } : {}),
      ...(manifest.pet?.alert ? { alert: manifest.pet.alert } : {}),
      ...(manifest.pet?.walk?.length ? { walk: manifest.pet.walk } : {}),
    },
    ...(manifest.wallpaper ? { wallpaper: manifest.wallpaper } : {}),
  };
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(themesRegistryPath(), "utf-8");
    const parsed = JSON.parse(raw) as Registry;
    if (parsed?.version === 1 && Array.isArray(parsed.themes)) return parsed;
  } catch {
    /* missing/corrupt → empty */
  }
  return { version: 1, themes: [] };
}

async function writeRegistry(registry: Registry): Promise<void> {
  await mkdir(dirname(themesRegistryPath()), { recursive: true, mode: 0o700 });
  const tmp = `${themesRegistryPath()}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, themesRegistryPath());
}

async function appendRegistryEntry(entry: RegistryEntry): Promise<void> {
  const registry = await readRegistry();
  registry.themes = registry.themes.filter((t) => t.id !== entry.id);
  registry.themes.push(entry);
  await writeRegistry(registry);
}

/** Read all installed themes (manifest re-read from disk), skipping broken ones. */
export async function listInstalledThemes(): Promise<InstalledTheme[]> {
  let ids: string[];
  try {
    const entries = await readdir(themesRoot(), { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
  const themes: InstalledTheme[] = [];
  for (const id of ids) {
    try {
      assertSafeThemeName(id);
      const manifest = await loadManifest(themeInstallDir(id));
      if (manifest.id !== id) continue; // dir name must match manifest id
      themes.push(toInstalledTheme(manifest));
    } catch {
      /* skip a corrupt/foreign directory */
    }
  }
  return themes;
}

/** Remove an installed theme and its registry entry. */
export async function uninstallTheme(id: string): Promise<void> {
  assertSafeThemeName(id);
  await rm(themeInstallDir(id), { recursive: true, force: true });
  const registry = await readRegistry();
  registry.themes = registry.themes.filter((t) => t.id !== id);
  await writeRegistry(registry);
}
