import { parse as parseToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import { serializeAgentDefinition } from "../../../agent/agent-definition.js";
import { PluginInstallError } from "../types.js";

const MAPPED = new Set(["name", "description", "model", "developer_instructions"]);

/**
 * Convert one Codex agent TOML into a CC agent Markdown string.
 * Real CC fields: name, description, model, body(=developer_instructions).
 * Every other field is preserved with a `codex_` prefix (v1 inert; see spec §7.1).
 * `mcp_servers` values are rewritten to `<plugin>:<server>` to match the MCP merge key.
 */
export function convertCodexAgentToml(
  toml: string,
  sourceName: string,
  pluginName: string,
): string {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(toml) as Record<string, unknown>;
  } catch (err) {
    throw new PluginInstallError(`${sourceName}: invalid TOML — ${(err as Error).message}`);
  }

  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new PluginInstallError(`${sourceName}: missing required 'name'`);
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    throw new PluginInstallError(`${sourceName}: missing required 'description'`);
  }

  const body =
    typeof raw.developer_instructions === "string" ? raw.developer_instructions.trim() : "";

  const base = serializeAgentDefinition({
    name: raw.name.trim(),
    description: raw.description.trim(),
    systemPrompt: body,
    ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
  });

  // Collect codex_-prefixed extras.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MAPPED.has(key)) continue;
    const outKey = `codex_${key}`;
    if (key === "mcp_servers" && Array.isArray(value)) {
      extras[outKey] = value.map((s) => (typeof s === "string" ? `${pluginName}:${s}` : s));
    } else {
      extras[outKey] = value;
    }
  }

  if (Object.keys(extras).length === 0) return base;

  // Splice the extra YAML lines into the existing frontmatter block.
  const extraYaml = stringifyYaml(extras).trimEnd();
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(base);
  if (!match) throw new PluginInstallError(`${sourceName}: internal — serializer produced no frontmatter`);
  const [, fm, rest] = match;
  return `---\n${fm}\n${extraYaml}\n---\n${rest}`;
}
