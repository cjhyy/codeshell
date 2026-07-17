import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { valid as validSemver } from "semver";
import { findPluginRoot, normalizePluginName } from "./installFromArchive.js";
import { installPluginFromPath } from "./install.js";
import { gunzipNpmTarball, extractNpmTar, MAX_NPM_TARBALL_BYTES } from "./npmTar.js";
import type { ParsedSource } from "./parseSource.js";
import { PluginInstallError } from "./types.js";

export const NPM_PUBLIC_REGISTRY = "https://registry.npmjs.org";
export const MAX_NPM_METADATA_BYTES = 4 * 1024 * 1024;
const NPM_FETCH_TIMEOUT_MS = 30_000;
const MAX_NPM_PACKAGE_JSON_BYTES = 1024 * 1024;

export interface ResolvedNpmPlugin {
  packageName: string;
  requestedSelector: string;
  resolvedVersion: string;
  tarballUrl: string;
  integrity: string;
}

export type NpmPluginFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface NpmPluginInstallOptions {
  /** Test seam; production always uses the platform fetch implementation. */
  fetch?: NpmPluginFetch;
}

type NpmVersionDocument = {
  name?: unknown;
  version?: unknown;
  dist?: { tarball?: unknown; integrity?: unknown };
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  bundledDependencies?: unknown;
  bundleDependencies?: unknown;
};

function assertRegistryUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PluginInstallError(`${label} is not a valid URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PluginInstallError(`${label} must use the fixed public registry.npmjs.org origin`);
  }
  return url;
}

function assertSelfContained(document: NpmVersionDocument): void {
  const dependencyFields: Array<keyof NpmVersionDocument> = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ];
  for (const field of dependencyFields) {
    const value = document[field];
    const populated =
      value === undefined || value === null || value === false
        ? false
        : Array.isArray(value)
          ? value.length > 0
          : typeof value === "object"
            ? Object.keys(value).length > 0
            : true;
    if (populated) {
      throw new PluginInstallError(
        `npm plugin declares ${field}; Phase A accepts self-contained packages only and never installs dependencies`,
      );
    }
  }
}

async function verifyExtractedPackage(
  packageDir: string,
  resolution: ResolvedNpmPlugin,
): Promise<void> {
  const manifestPath = join(packageDir, "package.json");
  let manifestStat;
  try {
    manifestStat = await stat(manifestPath);
  } catch {
    throw new PluginInstallError("npm tarball is missing package/package.json");
  }
  if (!manifestStat.isFile() || manifestStat.size > MAX_NPM_PACKAGE_JSON_BYTES) {
    throw new PluginInstallError("npm package.json is not a bounded regular file");
  }
  let document: NpmVersionDocument;
  try {
    document = JSON.parse(await readFile(manifestPath, "utf8")) as NpmVersionDocument;
  } catch (error) {
    throw new PluginInstallError(
      `npm tarball has malformed package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document.name !== resolution.packageName || document.version !== resolution.resolvedVersion) {
    throw new PluginInstallError(
      "npm tarball package identity does not match the reviewed registry metadata",
    );
  }
  assertSelfContained(document);
}

function sha512DigestFromIntegrity(integrity: string): Buffer {
  const token = integrity.split(/\s+/).find((candidate) => candidate.startsWith("sha512-"));
  if (!token) throw new PluginInstallError("npm package has no sha512 integrity value");
  const encoded = token.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) {
    throw new PluginInstallError("npm package sha512 integrity value is malformed");
  }
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    throw new PluginInstallError("npm package sha512 integrity value is malformed");
  }
  return digest;
}

async function checkedFetch(
  url: URL,
  accept: string,
  fetchImpl: NpmPluginFetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: accept,
        "Accept-Encoding": "identity",
        "User-Agent": "CodeShell-plugin-installer/1",
      },
      signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PluginInstallError(
      `public npm registry request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new PluginInstallError(
      `public npm registry returned HTTP ${response.status}; redirects and non-success responses are refused`,
    );
  }
  const lengthText = response.headers.get("content-length");
  if (lengthText && (!/^[0-9]+$/.test(lengthText) || !Number.isSafeInteger(Number(lengthText)))) {
    throw new PluginInstallError("public npm registry returned an invalid Content-Length");
  }
  return response;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  label: string,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    throw new PluginInstallError(`${label} exceeds ${limit} bytes`);
  }
  if (!response.body) throw new PluginInstallError(`${label} response has no body`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > limit) throw new PluginInstallError(`${label} exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  if (declared && total !== Number(declared)) {
    throw new PluginInstallError(`${label} length does not match Content-Length`);
  }
  return Buffer.concat(chunks, total);
}

/** Resolve an exact version or dist-tag to an immutable public-registry snapshot. */
export async function resolveNpmPlugin(
  parsed: Extract<ParsedSource, { kind: "npm" }>,
  options: NpmPluginInstallOptions = {},
): Promise<ResolvedNpmPlugin> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new PluginInstallError("fetch is unavailable");
  const metadataUrl = assertRegistryUrl(
    `${NPM_PUBLIC_REGISTRY}/${encodeURIComponent(parsed.packageName)}/${encodeURIComponent(parsed.selector)}`,
    "npm metadata URL",
  );
  const response = await checkedFetch(metadataUrl, "application/json", fetchImpl);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new PluginInstallError("public npm registry metadata response is not JSON");
  }
  const body = await readBoundedResponse(response, MAX_NPM_METADATA_BYTES, "npm metadata");
  let document: NpmVersionDocument;
  try {
    document = JSON.parse(body.toString("utf8")) as NpmVersionDocument;
  } catch (error) {
    throw new PluginInstallError(
      `public npm registry returned malformed metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (document.name !== parsed.packageName) {
    throw new PluginInstallError("npm metadata package name does not match the requested package");
  }
  if (typeof document.version !== "string" || !validSemver(document.version)) {
    throw new PluginInstallError("npm metadata did not resolve to an exact semantic version");
  }
  const resolvedVersion = validSemver(document.version)!;
  if (parsed.selectorKind === "exact" && resolvedVersion !== parsed.selector) {
    throw new PluginInstallError("npm registry resolved a different version than requested");
  }
  assertSelfContained(document);
  if (typeof document.dist?.tarball !== "string") {
    throw new PluginInstallError("npm metadata has no tarball URL");
  }
  assertRegistryUrl(document.dist.tarball, "npm tarball URL");
  if (typeof document.dist.integrity !== "string") {
    throw new PluginInstallError("npm metadata has no integrity value");
  }
  sha512DigestFromIntegrity(document.dist.integrity);
  return {
    packageName: parsed.packageName,
    requestedSelector: parsed.selector,
    resolvedVersion,
    tarballUrl: document.dist.tarball,
    integrity: document.dist.integrity,
  };
}

/** Download a tarball with a compressed-byte cap and verify SHA-512 before use. */
export async function downloadVerifiedNpmTarball(
  resolution: ResolvedNpmPlugin,
  targetPath: string,
  options: NpmPluginInstallOptions = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new PluginInstallError("fetch is unavailable");
  const url = assertRegistryUrl(resolution.tarballUrl, "npm tarball URL");
  const response = await checkedFetch(url, "application/octet-stream", fetchImpl);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType &&
    !["application/octet-stream", "application/gzip", "application/x-gzip"].some((allowed) =>
      contentType.includes(allowed),
    )
  ) {
    throw new PluginInstallError("npm tarball response has an unexpected Content-Type");
  }
  const contentEncoding = response.headers.get("content-encoding")?.toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new PluginInstallError("npm tarball HTTP content encoding must be identity");
  }
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_NPM_TARBALL_BYTES) {
    throw new PluginInstallError(`npm tarball exceeds ${MAX_NPM_TARBALL_BYTES} bytes`);
  }
  if (!response.body) throw new PluginInstallError("npm tarball response has no body");
  const hash = createHash("sha512");
  const output = await open(targetPath, "wx", 0o600);
  let total = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_NPM_TARBALL_BYTES) {
        throw new PluginInstallError(`npm tarball exceeds ${MAX_NPM_TARBALL_BYTES} bytes`);
      }
      hash.update(chunk);
      await output.write(chunk);
    }
  } catch (error) {
    await output.close();
    await rm(targetPath, { force: true });
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError(
      `npm tarball download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await output.close();
  if (declared && total !== Number(declared)) {
    await rm(targetPath, { force: true });
    throw new PluginInstallError("npm tarball length does not match Content-Length");
  }
  const expected = sha512DigestFromIntegrity(resolution.integrity);
  const actual = hash.digest();
  if (!timingSafeEqual(actual, expected)) {
    await rm(targetPath, { force: true });
    throw new PluginInstallError("npm tarball sha512 integrity check failed");
  }
}

/**
 * Install a self-contained plugin from the public npm registry. The resolved
 * exact version is recorded as the source; Phase A deliberately has no npm
 * dependency install, lifecycle execution, private registry, or auto-update.
 */
export async function installPluginFromNpm(
  parsed: ParsedSource,
  name: string | undefined,
  installedAt: string,
  options: NpmPluginInstallOptions = {},
): Promise<{ dir: string; name: string; resolution: ResolvedNpmPlugin }> {
  if (parsed.kind !== "npm") {
    throw new PluginInstallError("installPluginFromNpm expects an npm source");
  }
  const resolution = await resolveNpmPlugin(parsed, options);
  const resolvedName = normalizePluginName(name ?? parsed.inferredName);
  const temp = await mkdtemp(join(tmpdir(), "cs-tmp-npm-"));
  const tgzPath = join(temp, "package.tgz");
  const tarPath = join(temp, "package.tar");
  const extractPath = join(temp, "extract");
  try {
    await mkdir(extractPath, { mode: 0o700 });
    await downloadVerifiedNpmTarball(resolution, tgzPath, options);
    await gunzipNpmTarball(tgzPath, tarPath);
    await extractNpmTar(tarPath, extractPath);
    const packageDir = join(extractPath, "package");
    await verifyExtractedPackage(packageDir, resolution);
    const root = await findPluginRoot(packageDir);
    const dir = await installPluginFromPath(root, resolvedName, installedAt, {
      source: `npm:${resolution.packageName}@${resolution.resolvedVersion}`,
      version: resolution.resolvedVersion,
    });
    return { dir, name: resolvedName, resolution };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
