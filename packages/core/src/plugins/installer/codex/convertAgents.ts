import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import { serializeAgentDefinition } from "../../../agent/agent-definition.js";
import { PluginInstallError } from "../types.js";

const MAPPED = new Set(["name", "description", "model", "developer_instructions", "mcp_servers"]);

/**
 * Convert one Codex agent TOML into a CC agent Markdown string.
 * Real CodeShell fields: name, description, model, MCP allowlist and
 * body(=developer_instructions).
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
  let mcp: string[] | undefined;
  if (raw.mcp_servers !== undefined) {
    if (
      !Array.isArray(raw.mcp_servers) ||
      raw.mcp_servers.length > 256 ||
      raw.mcp_servers.some(
        (server) =>
          typeof server !== "string" ||
          server.length === 0 ||
          server.length > 256 ||
          !/^[A-Za-z0-9._-]+$/u.test(server),
      )
    ) {
      throw new PluginInstallError(
        `${sourceName}: 'mcp_servers' must be an array of at most 256 safe server names`,
      );
    }
    mcp = [...new Set(raw.mcp_servers.map((server) => `${pluginName}:${server}`))];
  }

  const base = serializeAgentDefinition({
    name: raw.name.trim(),
    description: raw.description.trim(),
    systemPrompt: body,
    ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  });

  // Collect codex_-prefixed extras.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MAPPED.has(key)) continue;
    const outKey = `codex_${key}`;
    extras[outKey] = value;
  }

  if (Object.keys(extras).length === 0) return base;

  // Splice the extra YAML lines into the existing frontmatter block.
  const extraYaml = stringifyYaml(extras).trimEnd();
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(base);
  if (!match)
    throw new PluginInstallError(`${sourceName}: internal — serializer produced no frontmatter`);
  const [, fm, rest] = match;
  return `---\n${fm}\n${extraYaml}\n---\n${rest}`;
}

/** Walk <sourceDir>/agents/**.toml → <destDir>/agents/**.md. */
export async function convertCodexAgentsDirectory(
  sourceDir: string,
  destDir: string,
  pluginName: string,
): Promise<void> {
  const agentsSrc = join(sourceDir, "agents");
  if (!existsSync(agentsSrc)) return;
  const sourceRoot = await realpath(sourceDir);
  const resolvedAgentsRoot = await resolveContainedAgentSource(sourceRoot, agentsSrc, "agents");

  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!dirent.name.endsWith(".toml")) continue;
      const source = await resolveContainedAgentSource(
        resolvedAgentsRoot,
        abs,
        relative(resolvedAgentsRoot, abs),
      );
      if (!(await stat(source)).isFile()) continue;
      const rel = relative(resolvedAgentsRoot, abs).replace(/\.toml$/, ".md");
      const outPath = join(destDir, "agents", rel);
      await mkdir(join(outPath, ".."), { recursive: true });
      const markdown = convertCodexAgentToml(await readFile(source, "utf-8"), rel, pluginName);
      await writeFile(outPath, markdown);
    }
  };
  await walk(resolvedAgentsRoot);
}

async function resolveContainedAgentSource(
  sourceRoot: string,
  candidate: string,
  label: string,
): Promise<string> {
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new PluginInstallError(`agent source not found: ${label}`);
  }
  const rel = relative(sourceRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginInstallError(`agent source escapes plugin dir: ${label}`);
  }
  return target;
}
