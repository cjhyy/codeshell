import type { GitPanelAppSourceInput } from "./installer.js";
import { PanelAppInstallError } from "./paths.js";

const MAX_SOURCE_PATH = 4_096;

export function normalizeGitPanelAppSource(input: GitPanelAppSourceInput): GitPanelAppSourceInput {
  if (!input || input.kind !== "git" || typeof input.url !== "string") {
    throw new PanelAppInstallError("GitHub Panel App source is invalid");
  }
  const raw = input.url.trim();
  if (!raw || raw.length > MAX_SOURCE_PATH || raw.includes("\0")) {
    throw new PanelAppInstallError("GitHub repository URL is invalid");
  }
  const urlText = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:\.git)?\/?$/.test(raw)
    ? `https://github.com/${raw}`
    : /^github\.com\//i.test(raw)
      ? `https://${raw}`
      : raw;
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new PanelAppInstallError("GitHub repository URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PanelAppInstallError(
      "Panel Apps support public https://github.com repositories only",
    );
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new PanelAppInstallError("GitHub URL must include owner/repository");
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new PanelAppInstallError("GitHub owner or repository name is invalid");
  }

  let urlRef: string | undefined;
  let urlSubdir: string | undefined;
  if (parts.length > 2) {
    if (parts[2] !== "tree" || !parts[3]) {
      throw new PanelAppInstallError("GitHub URL must point to a repository or /tree/<ref>/<path>");
    }
    urlRef = decodeURIComponent(parts[3]);
    urlSubdir =
      parts.length > 4
        ? parts
            .slice(4)
            .map((part) => decodeURIComponent(part))
            .join("/")
        : undefined;
  }
  if ((input.ref && urlRef) || (input.subdir && urlSubdir)) {
    throw new PanelAppInstallError(
      "GitHub tree URLs cannot be combined with separate ref or subdirectory fields",
    );
  }
  const ref = input.ref?.trim() || urlRef;
  const subdir = input.subdir?.trim().replaceAll("\\", "/") || urlSubdir;
  if (
    ref &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref.endsWith(".lock"))
  ) {
    throw new PanelAppInstallError("GitHub branch, tag, or commit is invalid");
  }
  if (subdir) {
    const segments = subdir.split("/");
    if (
      subdir.length > 1_024 ||
      subdir.startsWith("/") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new PanelAppInstallError("GitHub Panel App subdirectory is invalid");
    }
  }
  return {
    kind: "git",
    url: `https://github.com/${owner}/${repo}.git`,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
  };
}
