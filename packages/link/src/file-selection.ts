import { getLinkProviderManifest } from "./catalog.js";

export type LinkFileSelectionInput =
  | { kind: "github-file"; owner: string; repo: string; path: string; ref?: string; label?: string }
  | { kind: "figma-file"; fileUrlOrKey: string; label?: string };

function text(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`Invalid linked file ${field}`);
  return value.trim();
}

/** Provider-owned normalization, shared by Hosts without accepting arbitrary action JSON. */
export function resolveLinkFileSelection(providerId: string, input: unknown) {
  const capability = getLinkProviderManifest(providerId)?.fileSelection;
  if (!capability || !input || typeof input !== "object" || Array.isArray(input))
    throw new Error("This connection does not support document file selection");
  const file = input as Record<string, unknown>;
  if (file.kind !== capability.kind) throw new Error("Linked file belongs to another provider");
  const allowed =
    capability.kind === "github-file"
      ? ["kind", "owner", "repo", "path", "ref", "label"]
      : ["kind", "fileUrlOrKey", "label"];
  if (Object.keys(file).some((key) => !allowed.includes(key)))
    throw new Error("Unknown linked file field");
  const label = file.label === undefined ? undefined : text(file.label, "label", 512);
  let params: Record<string, string>, resourceId: string, defaultLabel: string;
  if (capability.kind === "github-file") {
    const owner = text(file.owner, "owner", 100).toLowerCase();
    const repo = text(file.repo, "repository", 100).toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner) ||
      !/^[a-z0-9_.-]+$/.test(repo) ||
      [".", ".."].includes(repo)
    )
      throw new Error("Invalid GitHub repository");
    const path = text(file.path, "path", 2_000);
    for (const segment of path.split("/")) {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* Literal percent signs are allowed. */
      }
      if (
        [segment, decoded].some(
          (part) => !part || part === "." || part === ".." || /[/\\]/.test(part),
        )
      )
        throw new Error("Invalid GitHub file path");
    }
    const ref = file.ref === undefined || file.ref === "" ? undefined : text(file.ref, "ref", 300);
    params = { owner, repo, path, ...(ref ? { ref } : {}) };
    resourceId = `${owner}/${repo}`;
    defaultLabel = `${resourceId}/${path}`;
  } else {
    let key = text(file.fileUrlOrKey, "Figma file", 1_000);
    if (key.startsWith("https://")) {
      const url = new URL(key);
      if (
        !["figma.com", "www.figma.com"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error("Invalid Figma file URL");
      if (/^\/make(?:\/|$)/.test(url.pathname))
        throw new Error(
          "unsupported_file_type: Figma Make links are not supported by Figma file REST actions; use a Design, FigJam, or file link",
        );
      key =
        /^\/(?:file|design|board)\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(url.pathname)?.[1] ?? "";
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw new Error("Invalid Figma file key");
    params = { file_url_or_key: key };
    resourceId = key;
    defaultLabel = `Figma · ${key}`;
  }
  return {
    providerId,
    action: capability.action,
    scopeId: `${providerId}:${capability.action}`,
    params,
    resourceId,
    label: label ?? defaultLabel.slice(-512),
  };
}
