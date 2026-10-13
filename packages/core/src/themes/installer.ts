/**
 * Theme-pack installer: validate → normalize → atomically install a local theme
 * pack into ~/.code-shell/themes/<id>/, and read/uninstall installed packs.
 *
 * Mirrors the plugin installer's discipline (safe names, canonical asset paths,
 * review-token double-check, temp-dir + rename atomicity) but is deliberately
 * self-contained and static-only: a theme pack is a manifest + media, never
 * executable content, so there are no hooks/mcp/skills to approve.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { detectThemeImage } from "./image.js";
import { detectThemeWav, MAX_THEME_MUSIC_BYTES, MAX_THEME_SOUND_BYTES } from "./audio.js";
import {
  THEME_SOUND_EVENTS,
  THEME_SURFACE_NAMES,
  parseThemeManifest,
  type ThemeManifest,
  type ThemeSurfaceName,
  type ThemeSoundEvent,
} from "./manifest.js";
import {
  THEME_ASSET_DIR,
  ThemeInstallError,
  ThemeReviewChangedError,
  assertSafeThemeName,
  themeInstallDir,
  themesRegistryPath,
  themesRoot,
} from "./paths.js";
import { lock } from "../utils/lockfile.js";
import { isThemePathWithinRoot, withLocalThemeSourceRoot } from "./source.js";

const MANIFEST_FILE = ".cs-theme.json";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_INSTALLED_THEMES = 1_000;
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
  surfaceNames?: ThemeSurfaceName[];
  hasFrame?: boolean;
  soundEvents?: ThemeSoundEvent[];
  musicCount?: number;
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
  surfaces?: ThemeManifest["surfaces"];
  frame?: ThemeManifest["frame"];
  sounds?: ThemeManifest["sounds"];
  music?: ThemeManifest["music"];
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

async function readAssetBytes(sourceDir: string, rel: string, maxBytes: number): Promise<Buffer> {
  const abs = resolve(sourceDir, rel);
  if (!isThemePathWithinRoot(resolve(sourceDir), abs)) {
    throw new ThemeInstallError(`asset escapes theme root: ${rel}`);
  }
  // The relative-path check above stops traversal, but not a symlink INSIDE
  // the pack pointing at an arbitrary file outside it. Resolve real paths and
  // require the asset to physically live under the pack root, or a malicious
  // pack could exfiltrate any readable file that happens to be valid media.
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = await realpath(sourceDir);
    realAbs = await realpath(abs);
  } catch {
    throw new ThemeInstallError(`asset not found: ${rel}`);
  }
  if (!isThemePathWithinRoot(realRoot, realAbs)) {
    throw new ThemeInstallError(`asset escapes theme root via symlink: ${rel}`);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      realAbs,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new ThemeInstallError(`asset not found: ${rel}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ThemeInstallError(`asset is not a file: ${rel}`);
    if (info.size > maxBytes) throw new ThemeInstallError(`asset too large: ${rel}`);
    // Read at most the reviewed size plus one byte, even if a source file is
    // concurrently enlarged after its metadata was checked.
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new ThemeInstallError(`asset changed while reading: ${rel}`);
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

async function readImageAsset(
  sourceDir: string,
  rel: string,
): Promise<{ bytes: Buffer; ext: string }> {
  const bytes = await readAssetBytes(sourceDir, rel, MAX_ASSET_BYTES);
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
  for (const name of THEME_SURFACE_NAMES) {
    await add(manifest.surfaces?.[name]?.light, `surface-${name}-light`);
    await add(manifest.surfaces?.[name]?.dark, `surface-${name}-dark`);
  }
  const addAudio = async (rel: string | undefined, base: string, music: boolean): Promise<void> => {
    if (!rel) return;
    const bytes = await readAssetBytes(
      sourceDir,
      rel,
      music ? MAX_THEME_MUSIC_BYTES : MAX_THEME_SOUND_BYTES,
    );
    const audio = detectThemeWav(bytes);
    if (!audio) throw new ThemeInstallError(`asset is not a supported PCM16 WAV: ${rel}`);
    if (audio.durationSeconds > (music ? 600 : 10)) {
      throw new ThemeInstallError(`audio duration exceeds ${music ? 600 : 10} seconds: ${rel}`);
    }
    const canonicalName = `${base}.wav`;
    assets.push({ sourceRel: rel, canonicalName });
    bytesByName.set(canonicalName, bytes);
  };
  for (const event of THEME_SOUND_EVENTS) {
    await addAudio(manifest.sounds?.[event], `sound-${event}`, false);
  }
  for (let index = 0; index < (manifest.music?.length ?? 0); index += 1) {
    await addAudio(manifest.music![index].file, `music-${index + 1}`, true);
  }
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
    raw = await readBoundedText(join(sourceDir, MANIFEST_FILE), MAX_MANIFEST_BYTES);
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

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
    throw new Error("state must be a bounded regular file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error("state must be a bounded regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
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
    ...(manifest.surfaces
      ? { surfaceNames: THEME_SURFACE_NAMES.filter((name) => manifest.surfaces?.[name]) }
      : {}),
    ...(manifest.frame && Object.keys(manifest.frame).length ? { hasFrame: true } : {}),
    ...(manifest.sounds
      ? { soundEvents: THEME_SOUND_EVENTS.filter((event) => manifest.sounds?.[event]) }
      : {}),
    ...(manifest.music ? { musicCount: manifest.music.length } : {}),
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
 * Validate a theme pack directory or ZIP and return a preview + review-token.
 * Does not change installed themes; temporary ZIP extraction is always removed.
 */
export async function previewLocalTheme(sourcePath: string): Promise<ThemePreview> {
  return withLocalThemeSourceRoot(sourcePath, previewThemeDirectory);
}

async function previewThemeDirectory(sourceDir: string): Promise<ThemePreview> {
  const manifest = await loadManifest(sourceDir);
  assertSafeThemeName(manifest.id);
  const warnings: string[] = [];
  if (
    !manifest.colors &&
    !manifest.pet &&
    !manifest.wallpaper &&
    !manifest.surfaces &&
    !manifest.frame &&
    !manifest.sounds &&
    !manifest.music?.length
  ) {
    warnings.push(
      "theme declares no colors, pet sprites, wallpaper, surfaces, frame, sounds, or music",
    );
  }
  const { bytesByName } = await resolveAssets(sourceDir, manifest);
  return previewOf(manifest, bytesByName, warnings);
}

/**
 * Install a previously previewed theme. Re-validates and re-checks the token
 * (rejecting mid-review changes), then atomically writes the theme to
 * ~/.code-shell/themes/<id>/ and records it in the registry. ZIP sources are
 * re-extracted privately so changed declared content requires a new review.
 */
export async function installReviewedLocalTheme(
  sourcePath: string,
  reviewToken: string,
): Promise<InstalledTheme> {
  return withLocalThemeSourceRoot(sourcePath, (root) =>
    installReviewedThemeDirectory(root, reviewToken),
  );
}

async function installReviewedThemeDirectory(
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

    const entry: RegistryEntry = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      installedAt: Date.now(),
    };
    await withRegistryLock(async (registry) => {
      const next: Registry = {
        version: 1,
        themes: [...registry.themes.filter((theme) => theme.id !== entry.id), entry],
      };
      assertRegistryCount(next);

      // Keep the previous install recoverable until the registry commit has
      // succeeded. Reading/validating the registry above happens before any
      // directory mutation, so corrupt legacy state cannot delete a theme.
      const backup = `${finalDir}.replace-${process.pid}-${randomUUID()}`;
      let hasBackup = false;
      let installedNew = false;
      try {
        try {
          const existing = await lstat(finalDir);
          if (existing.isSymbolicLink() || !existing.isDirectory()) {
            throw new Error("installed theme target must be a real directory");
          }
          await rename(finalDir, backup);
          hasBackup = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(staging, finalDir);
        installedNew = true;
        await writeRegistry(next);
      } catch (error) {
        if (installedNew) await rm(finalDir, { recursive: true, force: true });
        if (hasBackup) {
          try {
            await rename(backup, finalDir);
            hasBackup = false;
          } catch {
            throw new Error("theme install failed and the previous version could not be restored", {
              cause: error,
            });
          }
        }
        throw error;
      }
      // A committed install remains valid even if best-effort cleanup of the
      // hidden old directory is interrupted; a later maintenance pass can
      // safely remove the orphan.
      if (hasBackup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
  const surfaces = manifest.surfaces
    ? Object.fromEntries(
        THEME_SURFACE_NAMES.flatMap((name) => {
          const surface = manifest.surfaces?.[name];
          if (!surface) return [];
          // Preserve scalar appearance controls; only asset paths are rewritten.
          const { light: _light, dark: _dark, ...appearance } = surface;
          const light = rel(`surface-${name}-light`);
          const dark = rel(`surface-${name}-dark`);
          return [
            [name, { ...appearance, ...(light ? { light } : {}), ...(dark ? { dark } : {}) }],
          ];
        }),
      )
    : undefined;
  const sounds = manifest.sounds
    ? Object.fromEntries(
        THEME_SOUND_EVENTS.flatMap((event) => {
          const file = rel(`sound-${event}`);
          return file ? [[event, file]] : [];
        }),
      )
    : undefined;
  const music = manifest.music?.map((track, index) => ({
    title: track.title,
    ...(track.artist ? { artist: track.artist } : {}),
    ...(track.url ? { url: track.url } : { file: rel(`music-${index + 1}`)! }),
  }));
  return {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.colors ? { colors: manifest.colors } : {}),
    ...(pet && Object.keys(pet).length ? { pet } : {}),
    ...(wallpaper && Object.keys(wallpaper).length ? { wallpaper } : {}),
    ...(surfaces && Object.keys(surfaces).length ? { surfaces } : {}),
    ...(manifest.frame ? { frame: manifest.frame } : {}),
    ...(sounds && Object.keys(sounds).length ? { sounds } : {}),
    ...(music?.length ? { music } : {}),
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
    ...(manifest.surfaces ? { surfaces: manifest.surfaces } : {}),
    ...(manifest.frame ? { frame: manifest.frame } : {}),
    ...(manifest.sounds ? { sounds: manifest.sounds } : {}),
    ...(manifest.music ? { music: manifest.music } : {}),
  };
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readBoundedText(themesRegistryPath(), MAX_REGISTRY_BYTES);
    const parsed = JSON.parse(raw) as Registry;
    if (
      parsed?.version === 1 &&
      Array.isArray(parsed.themes) &&
      parsed.themes.length <= MAX_INSTALLED_THEMES &&
      parsed.themes.every(
        (theme) =>
          theme &&
          typeof theme === "object" &&
          typeof theme.id === "string" &&
          typeof theme.name === "string" &&
          theme.name.length <= 256 &&
          typeof theme.version === "string" &&
          theme.version.length <= 128 &&
          Number.isSafeInteger(theme.installedAt) &&
          theme.installedAt >= 0,
      )
    ) {
      for (const theme of parsed.themes) assertSafeThemeName(theme.id);
      return parsed;
    }
    throw new Error("theme registry is corrupt");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, themes: [] };
    throw error;
  }
}

async function writeRegistry(registry: Registry): Promise<void> {
  const path = themesRegistryPath();
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("theme registry parent must be a real directory");
  }
  try {
    const target = await lstat(path);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error("theme registry target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("theme registry is too large");
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, serialized, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(tmp, 0o600);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function withRegistryLock<T>(operation: (registry: Registry) => Promise<T> | T): Promise<T> {
  const directory = dirname(themesRegistryPath());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("theme registry parent must be a real directory");
  }
  const release = await lock(directory, {
    realpath: true,
    stale: 10_000,
    retries: { retries: 80, minTimeout: 10, maxTimeout: 120, factor: 1.3 },
  });
  try {
    const registry = await readRegistry();
    return await operation(registry);
  } finally {
    await release();
  }
}

function assertRegistryCount(registry: Registry): void {
  if (registry.themes.length > MAX_INSTALLED_THEMES) {
    throw new Error("too many installed themes");
  }
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
  const finalDir = themeInstallDir(id);
  await withRegistryLock(async (registry) => {
    const next: Registry = {
      version: 1,
      themes: registry.themes.filter((theme) => theme.id !== id),
    };
    const quarantine = `${finalDir}.remove-${process.pid}-${randomUUID()}`;
    let quarantined = false;
    try {
      const existing = await lstat(finalDir);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error("installed theme target must be a real directory");
      }
      await rename(finalDir, quarantine);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await writeRegistry(next);
    } catch (error) {
      if (quarantined) {
        await rename(quarantine, finalDir);
      }
      throw error;
    }
    // Registry commit is authoritative. Directory cleanup is retryable and
    // must not turn a successful uninstall into a registry/files mismatch.
    if (quarantined) {
      await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
