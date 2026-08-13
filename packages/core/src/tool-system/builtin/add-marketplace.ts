/**
 * Built-in AddMarketplace tool — register a plugin marketplace source so the
 * user can browse/install plugins from it in the UI. The tool only *adds the
 * source* (git clone + validate marketplace.json via core's addMarketplace);
 * which plugin to install is left to the user. Pairs with WebSearch/WebFetch:
 * the model can discover a marketplace repo, then add it.
 *
 * Side effects (network + git clone + disk write) → permissionDefault "ask".
 */

import type { ToolDefinition } from "../../types.js";
import { addMarketplace } from "../../plugins/marketplaceManager.js";
import { isValidMarketplaceName } from "../../plugins/knownMarketplaces.js";
import type { MarketplaceSource } from "../../plugins/types.js";

export const addMarketplaceToolDef: ToolDefinition = {
  name: "AddMarketplace",
  description:
    "Register a plugin marketplace source so the user can browse and install " +
    "plugins from it. Provide a short name and a source: either a GitHub repo " +
    "(owner/name) or a git URL. This only ADDS the source — it does not install " +
    "any plugin. Use WebSearch/WebFetch first to find a marketplace repo if you " +
    "don't already have one.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short local name for this marketplace (e.g. 'official').",
      },
      source_type: {
        type: "string",
        enum: ["github", "git"],
        description: "'github' for an owner/name repo, 'git' for a clone URL.",
      },
      repo: {
        type: "string",
        description: "GitHub repo in owner/name form (required when source_type='github').",
      },
      url: {
        type: "string",
        description: "Git clone URL (required when source_type='git').",
      },
    },
    required: ["name", "source_type"],
  },
};

export async function addMarketplaceTool(args: Record<string, unknown>): Promise<string> {
  const name = args.name;
  if (typeof name !== "string" || !name.trim()) {
    return "Error: name is required";
  }
  // Validate against the SAME rule the registry enforces on read. Accepting a
  // name here that knownMarketplaces later rejects would clone the repo and
  // then fail to persist it, leaving an orphaned directory behind.
  if (!isValidMarketplaceName(name)) {
    return (
      `Error: marketplace name '${name}' is not valid. Use letters or digits, ` +
      "then letters, digits, '.', '_' or '-' (max 128 characters)."
    );
  }
  const sourceType = args.source_type;
  let source: MarketplaceSource;
  if (sourceType === "github") {
    const repo = args.repo;
    if (typeof repo !== "string" || !repo.includes("/")) {
      return "Error: github source requires repo in owner/name form";
    }
    source = { source: "github", repo };
  } else if (sourceType === "git") {
    const url = args.url;
    if (typeof url !== "string" || !url.trim()) {
      return "Error: git source requires a url";
    }
    source = { source: "git", url };
  } else {
    return "Error: source_type must be 'github' or 'git'";
  }

  try {
    const result = await addMarketplace(name, source);
    if (!result.ok) {
      return `Error adding marketplace ${name}: ${result.error}`;
    }
    const preview = result.marketplace.plugins
      .slice(0, 25)
      .map((plugin) => `- ${plugin.name}${plugin.description ? ` — ${plugin.description}` : ""}`)
      .join("\n");
    const omitted = Math.max(0, result.marketplace.plugins.length - 25);
    return [
      `Marketplace '${name}' added (${result.marketplace.plugins.length} plugins).`,
      preview,
      omitted > 0 ? `… ${omitted} more plugins; browse them in Extensions → Market.` : "",
      "To install one in this conversation, call InstallCapability with kind='plugin', its exact plugin name, and this marketplace name.",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    return `Error adding marketplace ${name}: ${(err as Error).message}`;
  }
}
