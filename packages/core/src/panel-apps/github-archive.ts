import { open, rm } from "node:fs/promises";
import { PanelAppInstallError } from "./paths.js";

const GITHUB_ARCHIVE_TIMEOUT_MS = 45_000;
const MAX_GITHUB_ARCHIVE_BYTES = 128 * 1024 * 1024;
const USER_AGENT = "CodeShell-panel-app-installer/1";

/**
 * 只描述这里真正用到的能力：「用一个 URL 和 init 调用它，拿回 Response」。
 *
 * 刻意不写成 `typeof globalThis.fetch`。那是**完整**的运行时 fetch，包含
 * 实现自带的挂载属性——Bun 1.3 加了 `fetch.preconnect` 之后，每个只提供函数
 * 的测试 stub 都不再满足这个类型（`Property 'preconnect' is missing`），
 * 尽管本文件从头到尾只调用它。绑定到实际契约上，让运行时给 fetch 加静态属性
 * 不再变成下游的类型破坏。
 */
export type PanelAppArchiveFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubPanelAppArchiveSource {
  url: string;
  ref?: string;
}

function githubArchiveUrl(source: GitHubPanelAppArchiveSource): URL {
  const parsed = new URL(source.url);
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const owner = parts[0];
  const repository = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repository) {
    throw new PanelAppInstallError("GitHub Panel App source is invalid");
  }
  const ref = source.ref || "HEAD";
  const encodedRef = ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(
    `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zip/${encodedRef}`,
  );
}

/**
 * Download one atomic GitHub source snapshot with bounded memory and disk use.
 * Codeload avoids the smart-Git checkout path that can strand git-remote-https
 * helpers on poor networks. The caller selectively extracts the requested
 * Panel App subdirectory afterward.
 */
export async function downloadGitHubPanelAppArchive(
  source: GitHubPanelAppArchiveSource,
  targetPath: string,
  fetchImpl: PanelAppArchiveFetch = globalThis.fetch,
): Promise<void> {
  if (typeof fetchImpl !== "function") {
    throw new PanelAppInstallError("GitHub source download is unavailable");
  }
  const url = githubArchiveUrl(source);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/zip, application/octet-stream",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(GITHUB_ARCHIVE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PanelAppInstallError(
      `GitHub source download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) {
    throw new PanelAppInstallError("GitHub repository or ref was not found");
  }
  if (!response.ok) {
    throw new PanelAppInstallError(
      `GitHub source download returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  const declaredText = response.headers.get("content-length");
  const declared = declaredText ? Number(declaredText) : undefined;
  if (
    declaredText &&
    (!/^[0-9]+$/.test(declaredText) ||
      !Number.isSafeInteger(declared) ||
      declared! > MAX_GITHUB_ARCHIVE_BYTES)
  ) {
    throw new PanelAppInstallError(
      `GitHub source archive exceeds ${MAX_GITHUB_ARCHIVE_BYTES} bytes`,
    );
  }
  if (!response.body) {
    throw new PanelAppInstallError("GitHub source download returned an empty response");
  }

  const output = await open(targetPath, "wx", 0o600);
  let total = 0;
  let header = Buffer.alloc(0);
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_GITHUB_ARCHIVE_BYTES) {
        throw new PanelAppInstallError(
          `GitHub source archive exceeds ${MAX_GITHUB_ARCHIVE_BYTES} bytes`,
        );
      }
      if (header.length < 4) {
        header = Buffer.concat([header, chunk.subarray(0, 4 - header.length)]);
      }
      await output.write(chunk);
    }
    if (declared !== undefined && total !== declared) {
      throw new PanelAppInstallError("GitHub source archive length does not match Content-Length");
    }
    if (
      header.length !== 4 ||
      header[0] !== 0x50 ||
      header[1] !== 0x4b ||
      !((header[2] === 0x03 && header[3] === 0x04) || (header[2] === 0x05 && header[3] === 0x06))
    ) {
      throw new PanelAppInstallError("GitHub source response is not a ZIP archive");
    }
  } catch (error) {
    await output.close();
    await rm(targetPath, { force: true }).catch(() => undefined);
    if (error instanceof PanelAppInstallError) throw error;
    throw new PanelAppInstallError(
      `GitHub source download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await output.close();
}
