import { MAX_PANEL_DISCOVERY_DEPTH, MAX_PANEL_DISCOVERY_DIRECTORIES } from "./discovery.js";
import type { GitPanelAppSourceInput } from "./installer.js";
import { PANEL_APP_MANIFEST_FILE } from "./manifest.js";
import { normalizeGitPanelAppSource } from "./source.js";

export const MAX_PANEL_UPDATE_MANIFEST_BYTES = 1024 * 1024;
const GITHUB_MANIFEST_TIMEOUT_MS = 10_000;

type ManifestFetch = (input: URL, init: RequestInit) => Promise<Response>;

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("GitHub version check timed out"));
    };
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function githubManifestUrl(source: GitPanelAppSourceInput, root = source.subdir): URL {
  const repositoryPath = new URL(source.url).pathname.replace(/\.git$/, "");
  const path = [root, PANEL_APP_MANIFEST_FILE]
    .filter(Boolean)
    .join("/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return new URL(
    `https://raw.githubusercontent.com${repositoryPath}/${encodeURIComponent(source.ref ?? "HEAD")}/${path}`,
  );
}

async function readBoundedGitHubText(
  url: URL,
  fetchImpl: ManifestFetch,
  signal: AbortSignal,
  allowMissing = false,
): Promise<string | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    response = await withAbort(
      fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "User-Agent": "CodeShell-panel-app-version-check/1",
        },
        signal,
      }),
      signal,
    );
    if (response.status === 404) {
      if (allowMissing) return undefined;
      throw new Error("GitHub source manifest or ref was not found");
    }
    if (!response.ok) throw new Error(`GitHub version check returned HTTP ${response.status}`);
    const declaredText = response.headers.get("content-length");
    const declared = declaredText === null ? undefined : Number(declaredText);
    if (
      declaredText !== null &&
      (!/^[0-9]+$/.test(declaredText) ||
        !Number.isSafeInteger(declared) ||
        declared! > MAX_PANEL_UPDATE_MANIFEST_BYTES)
    ) {
      throw new Error("Panel App source manifest response exceeds the 1 MiB limit");
    }
    if (!response.body) throw new Error("GitHub source manifest is empty");
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await withAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PANEL_UPDATE_MANIFEST_BYTES) {
        throw new Error("Panel App source manifest response exceeds the 1 MiB limit");
      }
      chunks.push(Buffer.from(value));
    }
    if (declared !== undefined && total !== declared) {
      throw new Error("GitHub source manifest length does not match Content-Length");
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    // Cancellation must not delay a timed-out version check when a peer stops sending data.
    void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined);
  }
}

function uniqueGitHubPanelRoot(text: string, source: GitPanelAppSourceInput): string {
  const data: unknown = JSON.parse(text);
  if (
    !data ||
    typeof data !== "object" ||
    !("truncated" in data) ||
    data.truncated !== false ||
    !("tree" in data) ||
    !Array.isArray(data.tree)
  ) {
    throw new Error("GitHub directory discovery is incomplete; select the Panel App subdirectory");
  }
  const prefix = source.subdir ? `${source.subdir}/` : "";
  const candidates = new Set<string>();
  const directories = new Set<string>();
  for (const entry of data.tree) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      entry.path.length > 4_096 ||
      !["blob", "tree", "commit"].includes(entry.type)
    ) {
      throw new Error("GitHub directory discovery returned an invalid tree");
    }
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    const parts = relative.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
      throw new Error("GitHub directory discovery returned an invalid path");
    }
    if (
      entry.type === "tree" &&
      parts.length <= MAX_PANEL_DISCOVERY_DEPTH &&
      parts.every((part) => !part.startsWith(".") && part !== "node_modules")
    ) {
      directories.add(relative);
    }
    if (entry.type !== "blob" || parts.slice(-2).join("/") !== PANEL_APP_MANIFEST_FILE) continue;
    const rootParts = parts.slice(0, -2);
    if (
      rootParts.length > MAX_PANEL_DISCOVERY_DEPTH ||
      rootParts.some((part) => part.startsWith(".") || part === "node_modules")
    )
      continue;
    if (entry.mode === "120000") {
      throw new Error("GitHub Panel App manifest must not be a symbolic link");
    }
    candidates.add(rootParts.join("/"));
  }
  // Match installer discovery: once a panel root is found, its children are package contents.
  const roots = [...candidates].filter(
    (root) =>
      ![...candidates].some(
        (parent) => parent !== root && (!parent || root.startsWith(`${parent}/`)),
      ),
  );
  const visitedDirectories = [...directories].filter(
    (directory) => !roots.some((root) => !root || directory.startsWith(`${root}/`)),
  );
  if (visitedDirectories.length + 1 > MAX_PANEL_DISCOVERY_DIRECTORIES) {
    throw new Error("GitHub directory discovery limit exceeded; select the Panel App subdirectory");
  }
  if (roots.length !== 1) {
    throw new Error(
      roots.length > 1
        ? "multiple Panel Apps found; select the Panel App subdirectory"
        : "GitHub source manifest or ref was not found",
    );
  }
  return [source.subdir, roots[0]].filter(Boolean).join("/");
}

/**
 * Fetch only the source manifest. Legacy parent-directory installs use one bounded tree listing
 * after a 404, then read the unique panel manifest; package archives and code are never fetched.
 */
export async function readGitHubPanelAppManifest(
  input: GitPanelAppSourceInput,
  options: { fetch?: ManifestFetch; timeoutMs?: number } = {},
): Promise<string> {
  const source = normalizeGitPanelAppSource(input);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? GITHUB_MANIFEST_TIMEOUT_MS,
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const direct = await readBoundedGitHubText(
      githubManifestUrl(source),
      fetchImpl,
      controller.signal,
      true,
    );
    if (direct !== undefined) return direct;
    const repositoryPath = new URL(source.url).pathname.replace(/\.git$/, "");
    const treeUrl = new URL(
      `https://api.github.com/repos${repositoryPath}/git/trees/${encodeURIComponent(source.ref ?? "HEAD")}?recursive=1`,
    );
    const tree = await readBoundedGitHubText(treeUrl, fetchImpl, controller.signal);
    const root = uniqueGitHubPanelRoot(tree!, source);
    return (await readBoundedGitHubText(
      githubManifestUrl(source, root),
      fetchImpl,
      controller.signal,
    ))!;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
