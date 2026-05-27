import { parse as parseYaml } from "yaml";

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
  /** Markdown body — becomes the child Engine's appendSystemPrompt. */
  systemPrompt: string;
}

interface RawFrontmatter {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  maxTurns?: unknown;
  tools?: unknown;
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
  if (Array.isArray(fm.tools)) {
    def.tools = fm.tools.filter((t): t is string => typeof t === "string");
  }
  return def;
}
