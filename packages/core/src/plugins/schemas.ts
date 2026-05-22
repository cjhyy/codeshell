/**
 * Lightweight validators for plugin marketplace JSON shapes. Returns
 * { ok, value } | { ok: false, error } so callers can use the error
 * string in user-facing slash command output.
 */

import type {
  PluginMarketplace,
  PluginMarketplaceEntry,
  PluginEntrySource,
  ValidationResult,
} from "./types.js";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validatePluginEntrySource(
  raw: unknown,
  path: string,
): ValidationResult<PluginEntrySource> {
  if (typeof raw === "string") {
    if (raw.length === 0) return { ok: false, error: `${path}: source string is empty` };
    return { ok: true, value: raw };
  }
  if (!isObject(raw)) {
    return { ok: false, error: `${path}: source must be a string or object` };
  }
  const kind = raw.source;
  if (kind === "git") {
    if (typeof raw.url !== "string" || !raw.url) {
      return { ok: false, error: `${path}: git source requires url` };
    }
    return {
      ok: true,
      value: {
        source: "git",
        url: raw.url,
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
        sha: typeof raw.sha === "string" ? raw.sha : undefined,
      },
    };
  }
  if (kind === "github") {
    if (typeof raw.repo !== "string" || !raw.repo.includes("/")) {
      return { ok: false, error: `${path}: github source requires repo "owner/name"` };
    }
    return {
      ok: true,
      value: {
        source: "github",
        repo: raw.repo,
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
        sha: typeof raw.sha === "string" ? raw.sha : undefined,
      },
    };
  }
  if (kind === "git-subdir") {
    if (typeof raw.url !== "string" || !raw.url) {
      return { ok: false, error: `${path}: git-subdir source requires url` };
    }
    if (typeof raw.path !== "string" || !raw.path) {
      return { ok: false, error: `${path}: git-subdir source requires path` };
    }
    return {
      ok: true,
      value: {
        source: "git-subdir",
        url: raw.url,
        path: raw.path,
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
        sha: typeof raw.sha === "string" ? raw.sha : undefined,
      },
    };
  }
  return {
    ok: false,
    error: `${path}: unsupported source type "${String(kind)}" (MVP supports git, github, git-subdir, or a string path)`,
  };
}

export function validatePluginEntry(
  raw: unknown,
  index: number,
): ValidationResult<PluginMarketplaceEntry> {
  const path = `plugins[${index}]`;
  if (!isObject(raw)) return { ok: false, error: `${path}: must be an object` };
  if (typeof raw.name !== "string" || !raw.name) {
    return { ok: false, error: `${path}: name is required` };
  }
  if (raw.source === undefined) {
    return { ok: false, error: `${path}: source is required` };
  }
  const source = validatePluginEntrySource(raw.source, `${path}.source`);
  if (!source.ok) return source;

  let author: PluginMarketplaceEntry["author"];
  if (raw.author !== undefined) {
    if (!isObject(raw.author) || typeof raw.author.name !== "string") {
      return { ok: false, error: `${path}.author: must be an object with name` };
    }
    author = {
      name: raw.author.name,
      email: typeof raw.author.email === "string" ? raw.author.email : undefined,
    };
  }

  return {
    ok: true,
    value: {
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      author,
      category: typeof raw.category === "string" ? raw.category : undefined,
      source: source.value,
      homepage: typeof raw.homepage === "string" ? raw.homepage : undefined,
    },
  };
}

export function validateMarketplace(raw: unknown): ValidationResult<PluginMarketplace> {
  if (!isObject(raw)) return { ok: false, error: "marketplace.json: not an object" };
  if (typeof raw.name !== "string" || !raw.name) {
    return { ok: false, error: "marketplace.json: name is required" };
  }
  if (!isObject(raw.owner) || typeof raw.owner.name !== "string") {
    return { ok: false, error: "marketplace.json: owner.name is required" };
  }
  if (!Array.isArray(raw.plugins)) {
    return { ok: false, error: "marketplace.json: plugins must be an array" };
  }
  const plugins: PluginMarketplaceEntry[] = [];
  for (let i = 0; i < raw.plugins.length; i++) {
    const r = validatePluginEntry(raw.plugins[i], i);
    if (!r.ok) return r;
    plugins.push(r.value);
  }
  return {
    ok: true,
    value: {
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      owner: {
        name: raw.owner.name,
        email: typeof raw.owner.email === "string" ? raw.owner.email : undefined,
      },
      plugins,
    },
  };
}
