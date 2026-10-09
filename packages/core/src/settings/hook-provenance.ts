/**
 * Host-only custody for opt-in executable Hook origins. These values contain
 * file identity, not Settings contents or a review's permission callback.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_SETTINGS_FILE_BYTES = 4 * 1024 * 1024;

export interface SettingsHookFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly nlink: string;
}

export interface SettingsHookParentIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
}

export interface SettingsHookSourceSnapshot {
  readonly path: string;
  readonly rawSha256: string;
  readonly custody: {
    readonly jsonPath: string;
    readonly file: SettingsHookFileIdentity;
    readonly parents: readonly SettingsHookParentIdentity[];
    readonly precedingCandidates: readonly string[];
  };
}

export interface SettingsHookOrigin extends SettingsHookSourceSnapshot {
  readonly kind: "settings";
  readonly layer: "managed" | "user" | "project" | "local";
  readonly sourceLayerIndex: number;
  readonly definitionSha256: string;
}

function identity(info: BigIntStats): SettingsHookFileIdentity {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    mode: String(info.mode),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
    nlink: String(info.nlink),
  });
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parents(path: string): readonly SettingsHookParentIdentity[] {
  const paths: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    paths.unshift(current);
    if (dirname(current) === current) break;
  }
  return Object.freeze(
    paths.map((path) => {
      const info = lstatSync(path, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Settings Hook origin traversal is unsafe");
      }
      return Object.freeze({
        path,
        dev: String(info.dev),
        ino: String(info.ino),
        mode: String(info.mode),
      });
    }),
  );
}

function absent(path: string): boolean {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function assertRegular(info: BigIntStats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size < 0n ||
    info.size > BigInt(MAX_SETTINGS_FILE_BYTES)
  ) {
    throw new Error("Settings Hook origin is not a bounded single-link regular file");
  }
}

/**
 * Hash and fatal UTF-8 decode the same bounded descriptor Buffer. Ancestor
 * checks are metadata custody checks, not an atomic directory-fd walk or an
 * assertion that transient hostile ancestor ABA changes are impossible.
 */
export function readSettingsHookSnapshot(jsonPath: string): {
  readonly content: string;
  readonly source: SettingsHookSourceSnapshot;
} {
  const canonicalJsonPath = resolve(jsonPath);
  const parentPins = parents(canonicalJsonPath);
  const base = canonicalJsonPath.replace(/\.json$/, "");
  const precedingCandidates: string[] = [];
  let selected: string | undefined;
  for (const candidate of [canonicalJsonPath, `${base}.yaml`, `${base}.yml`]) {
    if (absent(candidate)) precedingCandidates.push(candidate);
    else {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw new Error("Settings Hook origin is absent");
  const path = selected;
  const opening = lstatSync(path, { bigint: true });
  assertRegular(opening);
  if (realpathSync(path) !== path) throw new Error("Settings Hook origin is not canonical");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptor = fstatSync(fd, { bigint: true });
    assertRegular(descriptor);
    const file = identity(opening);
    if (!equal(file, identity(descriptor))) throw new Error("Settings Hook origin changed at open");
    // One extra byte proves growth beyond the opening length while retaining
    // the global hard bound; tiny settings do not allocate 4 MiB per recheck.
    const buffer = Buffer.allocUnsafe(Number(opening.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const finalDescriptor = fstatSync(fd, { bigint: true });
    const finalPath = lstatSync(path, { bigint: true });
    assertRegular(finalDescriptor);
    assertRegular(finalPath);
    if (
      length > MAX_SETTINGS_FILE_BYTES ||
      BigInt(length) !== opening.size ||
      !equal(file, identity(finalDescriptor)) ||
      !equal(file, identity(finalPath)) ||
      !equal(parentPins, parents(path)) ||
      precedingCandidates.some((candidate) => !absent(candidate)) ||
      realpathSync(path) !== path
    ) {
      throw new Error("Settings Hook origin changed during capture");
    }
    const bytes = buffer.subarray(0, length);
    const rawSha256 = createHash("sha256").update(bytes).digest("hex");
    // Do not label a replacement-decoded UTF-8 string as the raw byte hash.
    // Preserve U+FEFF exactly as readFileSync(..., "utf8"): JSON.parse must
    // continue rejecting BOM-prefixed JSON; YAML keeps its existing parser.
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const source: SettingsHookSourceSnapshot = Object.freeze({
      path,
      rawSha256,
      custody: Object.freeze({
        jsonPath: canonicalJsonPath,
        file,
        parents: parentPins,
        precedingCandidates: Object.freeze(precedingCandidates),
      }),
    });
    return Object.freeze({ content, source });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** No manager, owner, grant, AbortSignal or resource resolver is retained. */
export function assertSettingsHookOriginCurrent(origin: SettingsHookOrigin): void {
  const current = readSettingsHookSnapshot(origin.custody.jsonPath).source;
  if (
    current.path !== origin.path ||
    current.rawSha256 !== origin.rawSha256 ||
    !equal(current.custody, origin.custody)
  ) {
    throw new Error("Settings Hook origin custody changed");
  }
}

/**
 * A previously byte-verified immutable source keeps its full file identity.
 * Recheck all custody facts without rehashing the same Settings for every
 * mapped resource. Current-review policy loads still read/hash fresh RAW bytes.
 */
export function assertSettingsHookOriginMetadataCurrent(origin: SettingsHookOrigin): void {
  const current = lstatSync(origin.path, { bigint: true });
  assertRegular(current);
  if (
    !equal(identity(current), origin.custody.file) ||
    !equal(parents(origin.path), origin.custody.parents) ||
    origin.custody.precedingCandidates.some((candidate) => !absent(candidate)) ||
    realpathSync(origin.path) !== origin.path
  )
    throw new Error("Settings Hook origin custody changed");
}

/** Stable digest of a validated Hook definition, independent of JSON key order. */
export function settingsHookDefinitionSha256(hook: unknown): string {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)]),
    );
  }
  return createHash("sha256")
    .update(JSON.stringify(ordered(hook)))
    .digest("hex");
}
