import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseAgentDefinition, type AgentDefinition } from "../agent/agent-definition.js";
import { readInstalledPlugins } from "../plugins/installedPlugins.js";
import { userHome } from "../settings/manager.js";
import type { WorkspaceProfile } from "./types.js";
import { ProfileExportReader, missing, safeSegment } from "./plugin-export-files.js";
import type { ProfilePluginExportComponent } from "./plugin-export-types.js";

export interface ExportSource {
  component: ProfilePluginExportComponent;
  raw: string;
  root: string;
  pluginName?: string;
  agent?: AgentDefinition;
  support: Map<string, { path: string; relativePath: string }>;
}

export function exportId(kind: string, name: string): string {
  return createHash("sha256").update(`${kind}\0${name}`).digest("hex");
}
export function exportName(kind: string, name: string): string {
  return `${kind}-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "component"
  }-${exportId(kind, name).slice(0, 12)}`;
}
function component(kind: "skill" | "agent", name: string): ProfilePluginExportComponent {
  return {
    id: exportId(kind, name),
    kind,
    name,
    exportName: exportName(kind, name),
    selected: false,
    textFiles: [],
  };
}
function pluginName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}
function failure(error: unknown): string {
  // Never return raw filesystem/YAML errors that contain private absolute paths or source bytes.
  return error instanceof Error && !("code" in error)
    ? error.message
    : "source is unavailable or changed";
}

/** Strict validation before using the runtime's permissive Markdown parser. */
export function strictExportAgent(raw: string): AgentDefinition {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) throw new Error("agent is missing YAML frontmatter");
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(match[1], { maxAliasCount: 0 });
  } catch {
    throw new Error("agent frontmatter is invalid or uses aliases");
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm))
    throw new Error("agent frontmatter must be an object");
  const known = new Set([
    "name",
    "description",
    "model",
    "maxTurns",
    "tools",
    "skills",
    "sandbox",
    "mcp",
  ]);
  if (Object.keys(fm).some((key) => !known.has(key)))
    throw new Error("agent has unsupported frontmatter; its policy cannot be faithfully exported");
  for (const field of ["tools", "skills", "mcp"] as const) {
    const value = fm[field];
    if (
      value !== undefined &&
      !(
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256))
      )
    ) {
      throw new Error(
        `agent ${field} must be an explicit string/list; invalid restrictions cannot become inheritance`,
      );
    }
  }
  if (
    fm.sandbox !== undefined &&
    !["off", "auto", "seatbelt", "bwrap"].includes(fm.sandbox as string)
  )
    throw new Error("agent sandbox policy is unsupported");
  if (
    fm.maxTurns !== undefined &&
    (!Number.isSafeInteger(fm.maxTurns) || (fm.maxTurns as number) < 1)
  )
    throw new Error("agent turn limit is invalid");
  if (fm.model !== undefined && (typeof fm.model !== "string" || !fm.model.trim()))
    throw new Error("agent model is invalid");
  try {
    return parseAgentDefinition(raw, "selected agent");
  } catch {
    throw new Error("agent name/description/frontmatter is invalid");
  }
}

export function discoverProfileExportSources(
  profile: WorkspaceProfile,
  cwd: string,
  reader: ProfileExportReader,
): ExportSource[] {
  const project = reader.directory(cwd);
  const home = reader.directory(userHome());
  if (!project || !home) throw new Error("configuration source root is unavailable");
  const installed = readInstalledPlugins();
  const result: ExportSource[] = [];
  for (const name of profile.skills) {
    const item: ExportSource = {
      component: component("skill", name),
      raw: "",
      root: "",
      support: new Map(),
    };
    result.push(item);
    try {
      let found = false;
      // Runtime scans local literal directory names first, including ':' on
      // POSIX. Never silently substitute a plugin's identically named Skill.
      if (name.includes(":")) {
        for (const [base, boundary] of [
          [join(project, ".code-shell", "skills"), project],
          [join(project, ".agents", "skills"), project],
          [join(home, ".code-shell", "skills"), home],
        ]) {
          const root = reader.directory(base, boundary);
          if (root && reader.hasLiteralDirectory(root, name))
            throw new Error(
              "qualified Skill name conflicts with a local literal directory; resolve this non-portable name before export",
            );
        }
      }
      // Local Skill names are literal directory names. Qualified plugin names cannot become paths.
      if (safeSegment(name)) {
        for (const [base, source, boundary] of [
          [join(project, ".code-shell", "skills"), "project", project],
          [join(project, ".agents", "skills"), "project", project],
          [join(home, ".code-shell", "skills"), "user", home],
        ] as const) {
          if (!reader.directory(base, boundary)) continue;
          const root = reader.directory(join(base, name), boundary);
          if (!root) continue;
          try {
            item.raw = reader.read(root, join(root, "SKILL.md"));
          } catch (error) {
            if (missing(error)) continue;
            throw error;
          }
          item.root = root;
          item.component.source = source;
          found = true;
          break;
        }
      }
      if (!found) {
        const parts = name.split(":");
        if (parts.length === 2 && parts.every(safeSegment)) {
          for (const key of Object.keys(installed.plugins).sort()) {
            if (pluginName(key) !== parts[0]) continue;
            for (const entry of installed.plugins[key]) {
              const installRoot = reader.directory(entry.installPath);
              if (!installRoot) continue;
              const root = reader.directory(join(installRoot, "skills", parts[1]), installRoot);
              if (!root) continue;
              try {
                item.raw = reader.read(root, join(root, "SKILL.md"));
              } catch (error) {
                if (missing(error)) continue;
                throw error;
              }
              item.root = root;
              item.component.source = "plugin";
              item.pluginName = parts[0];
              found = true;
              break;
            }
            if (found) break;
          }
        }
      }
      if (!found)
        throw new Error("declared Skill is missing or is not a supported static Skill source");
    } catch (error) {
      item.component.blocked = failure(error);
    }
  }

  if (!profile.agents.length) return result;
  const requested = new Set(profile.agents);
  const winners = new Map<string, ExportSource>();
  const dirs: Array<{
    dir: string;
    source: "user" | "plugin" | "project";
    boundary: string;
    pluginName?: string;
  }> = [{ dir: join(home, ".code-shell", "agents"), source: "user", boundary: home }];
  for (const [key, entries] of Object.entries(installed.plugins)) {
    for (const entry of entries) {
      dirs.push({
        dir: join(entry.installPath, "agents"),
        source: "plugin",
        boundary: entry.installPath,
        pluginName: pluginName(key),
      });
    }
  }
  dirs.push({ dir: join(project, ".code-shell", "agents"), source: "project", boundary: project });
  let inventoryFailure: string | undefined;
  try {
    for (const dir of dirs) {
      const boundary = reader.directory(dir.boundary);
      if (!boundary) continue;
      const root = reader.directory(join(boundary, relative(dir.boundary, dir.dir)), boundary);
      if (!root) continue;
      for (const file of reader.files(root, (name) => name.endsWith(".md"))) {
        const raw = reader.read(root, file);
        let parsed: AgentDefinition;
        try {
          parsed = parseAgentDefinition(raw, "agent inventory");
        } catch {
          continue;
        } // Runtime registry also skips malformed definitions.
        if (!requested.has(parsed.name)) continue;
        const item: ExportSource = {
          component: component("agent", parsed.name),
          raw,
          root,
          pluginName: dir.pluginName,
          support: new Map(),
        };
        item.component.source = dir.source;
        try {
          item.agent = strictExportAgent(raw);
        } catch (error) {
          item.component.blocked = failure(error);
        }
        if (winners.has(parsed.name))
          item.component.blocked =
            "multiple Agent definitions share this name; resolve the override before exporting";
        winners.set(parsed.name, item);
      }
    }
  } catch (error) {
    inventoryFailure = failure(error);
  }
  for (const name of profile.agents) {
    const item = winners.get(name) ?? {
      component: component("agent", name),
      raw: "",
      root: "",
      support: new Map(),
    };
    if (inventoryFailure || !winners.has(name))
      item.component.blocked = inventoryFailure ?? "declared Agent is missing";
    result.push(item);
  }
  return result;
}

export function discoverSupportText(item: ExportSource, reader: ProfileExportReader): void {
  for (const path of reader.files(
    item.root,
    (name) => /\.(md|txt)$/i.test(name) && name !== "SKILL.md",
  )) {
    const relativePath = relative(item.root, path).replace(/\\/g, "/");
    const id = exportId(item.component.id, relativePath);
    item.support.set(id, { path, relativePath });
    item.component.textFiles.push({ id, path: relativePath, selected: false });
  }
}
