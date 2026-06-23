import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** A reusable sub-agent role, loaded from a Markdown file. */
export interface AgentDefinition {
  /** Unique role key, e.g. "researcher". Matched against Agent({ agent_type }). */
  name: string;
  /** Human-facing summary of when to use this role. */
  description: string;
  /** Optional ModelPool key (e.g. "flash"). Undefined → inherit parent model. */
  model?: string;
  /** Optional turn cap for this role. Undefined → caller/default decides. */
  maxTurns?: number;
  /** Optional tool allowlist. Undefined → inherit parent's full tool set. */
  tools?: string[];
  /**
   * Optional skill allowlist. Undefined → inherit the parent's full skill
   * pool (every non-disabled skill in the project). When set, the sub-agent
   * physically only sees these skills: they're the only ones listed in its
   * system prompt and the only ones it may invoke. Empty array → no skills.
   */
  skills?: string[];
  /** Markdown body — becomes the child Engine's appendSystemPrompt. */
  systemPrompt: string;
  /** Where this def was loaded from. Runtime-only; never serialized. */
  source?: "project" | "user" | "plugin";
  /**
   * Owning plugin name when source === "plugin" (e.g. "mimi-video"). Runtime-
   * only; never serialized. Used to namespace this agent's bare skill
   * allowlist into `<pluginName>:<skill>` at spawn time, since a plugin's
   * frontmatter references its own skills by bare name (CC convention) but
   * the scanner registers them namespaced. Undefined for project/user agents.
   */
  pluginName?: string;
  /** Absolute path of the file it came from. Runtime-only. */
  filePath?: string;
  /** True when this def shadows a same-named def from a lower-priority dir. */
  override?: boolean;
  /** Sources whose same-named def this one shadows (runtime-only). Drives the
   *  UI "this project overrides your user version" warning (spec §7.2). */
  shadowedSources?: Array<"project" | "user" | "plugin">;
}

interface RawFrontmatter {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  maxTurns?: unknown;
  tools?: unknown;
  skills?: unknown;
}

/**
 * Normalize a frontmatter `tools:` / `skills:` value into a string[].
 * Accepts both a YAML list (`[a, b]`) and a comma/whitespace-separated
 * string (`a, b`) — CC-lineage agent files use either form. Returns
 * undefined when the field is absent or not a usable shape, so the caller
 * keeps the "inherit parent" default.
 */
function normalizeNameList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((t): t is string => typeof t === "string");
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

/**
 * Parse a Markdown agent-definition file (YAML frontmatter + body).
 * Pure: no filesystem access. `sourceName` is only used in error messages.
 */
export function parseAgentDefinition(raw: string, sourceName: string): AgentDefinition {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${sourceName}: missing YAML frontmatter (expected leading '---' block)`);
  }
  const [, yamlSrc, body] = match;
  let fm: RawFrontmatter;
  try {
    fm = (parseYaml(yamlSrc) ?? {}) as RawFrontmatter;
  } catch (err) {
    throw new Error(`${sourceName}: invalid YAML frontmatter — ${(err as Error).message}`, { cause: err });
  }

  if (typeof fm.name !== "string" || fm.name.trim().length === 0) {
    throw new Error(`${sourceName}: frontmatter must include a non-empty 'name'`);
  }
  if (typeof fm.description !== "string" || fm.description.trim().length === 0) {
    throw new Error(`${sourceName}: frontmatter must include a non-empty 'description'`);
  }

  const def: AgentDefinition = {
    name: fm.name.trim(),
    description: fm.description.trim(),
    systemPrompt: body.trim(),
  };
  if (typeof fm.model === "string" && fm.model.trim()) def.model = fm.model.trim();
  if (typeof fm.maxTurns === "number") def.maxTurns = fm.maxTurns;
  const tools = normalizeNameList(fm.tools);
  if (tools !== undefined) def.tools = tools;
  const skills = normalizeNameList(fm.skills);
  if (skills !== undefined) def.skills = skills;
  return def;
}

/**
 * Serialize an AgentDefinition back to a Markdown file body (YAML
 * frontmatter + system prompt). Inverse of parseAgentDefinition.
 * Optional fields that are unset are omitted entirely so an inheriting
 * role (e.g. model undefined → inherit parent) stays clean on disk.
 * Runtime-only metadata (source/filePath/override) is never written.
 */
export function serializeAgentDefinition(def: AgentDefinition): string {
  const fm: Record<string, unknown> = {
    name: def.name,
    description: def.description,
  };
  if (def.model !== undefined) fm.model = def.model;
  if (def.maxTurns !== undefined) fm.maxTurns = def.maxTurns;
  if (def.tools !== undefined) fm.tools = def.tools;
  if (def.skills !== undefined) fm.skills = def.skills;
  const yaml = stringifyYaml(fm).trimEnd();
  return `---\n${yaml}\n---\n${def.systemPrompt}\n`;
}
