import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { serializeAgentDefinition } from "../agent/agent-definition.js";
import { readWorkspaceProfile } from "./store.js";
import { WORKSPACE_PROFILE_NAME_RE } from "./types.js";
import { ProfileExportReader, safeSegment } from "./plugin-export-files.js";
import { discoverProfileExportSources, discoverSupportText } from "./plugin-export-sources.js";
import {
  PROFILE_PLUGIN_EXPORT_LIMITS as LIMITS,
  type ProfilePluginExportFile,
  type ProfilePluginExportSelection,
  type ProfilePluginExportSnapshot,
} from "./plugin-export-types.js";

export * from "./plugin-export-types.js";

export function validateProfilePluginExportSelection(input: unknown): ProfilePluginExportSelection {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("export selection is required");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["componentIds", "textFileIds", "includeInstruction"].includes(key),
    )
  )
    throw new Error("unknown export selection field");
  for (const key of ["componentIds", "textFileIds"] as const) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length > LIMITS.files ||
      value[key].some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(value[key]).size !== value[key].length
    )
      throw new Error("invalid export selection IDs");
  }
  if (typeof value.includeInstruction !== "boolean")
    throw new Error("instruction selection must be explicit");
  return value as unknown as ProfilePluginExportSelection;
}

function staticSkill(raw: string, name: string): string {
  const match = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(raw);
  if (!match) throw new Error("Skill is missing valid YAML frontmatter");
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(match[1], { maxAliasCount: 0 });
  } catch {
    throw new Error("Skill frontmatter is invalid or uses aliases");
  }
  if (
    !fm ||
    typeof fm !== "object" ||
    Array.isArray(fm) ||
    typeof fm.description !== "string" ||
    !fm.description.trim()
  )
    throw new Error("Skill needs an explicit text description");
  const supported = new Set([
    "name",
    "description",
    "allowed-tools",
    "model",
    "disable-model-invocation",
    "user-invocable",
    "argument-hint",
    "license",
    "compatibility",
  ]);
  if (Object.keys(fm).some((key) => !supported.has(key)))
    throw new Error(
      "Skill has unsupported frontmatter (including hooks/fork references); review it before exporting",
    );
  const tools = fm["allowed-tools"];
  if (
    tools !== undefined &&
    !(
      typeof tools === "string" ||
      (Array.isArray(tools) && tools.every((item) => typeof item === "string"))
    )
  )
    throw new Error("Skill tool policy cannot be faithfully exported");
  if ((typeof tools === "string" && tools.trim()) || (Array.isArray(tools) && tools.length))
    throw new Error(
      "non-empty Skill allowed-tools can pre-approve tools in CC; static export blocks this grant",
    );
  for (const field of ["model", "argument-hint", "license", "compatibility"]) {
    if (fm[field] !== undefined && typeof fm[field] !== "string")
      throw new Error("Skill frontmatter field has an unsupported value");
  }
  for (const field of ["disable-model-invocation", "user-invocable"]) {
    if (fm[field] !== undefined && typeof fm[field] !== "boolean")
      throw new Error("Skill invocation restriction has an unsupported value");
  }
  const body = raw.slice(match[0].length);
  if (/!`/.test(body) || /(?:^|\n)[ \t]*(?:`{3,}|~{3,})!/.test(body))
    throw new Error(
      "Skill body contains a CC dynamic command marker; static export never executes or removes it",
    );
  // Empty Skill tool policy is preserved without claiming it denies tools.
  // Agent allowlists have a different contract and are handled separately.
  return `---\n${stringifyYaml({ ...fm, name }).trimEnd()}\n---\n${body}`;
}

export function safeExportRelativePath(path: string): boolean {
  return (
    path.length <= 1024 &&
    path
      .split("/")
      .every(
        (part) =>
          safeSegment(part) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

/** Pure snapshot after bounded source reads. It neither installs nor activates anything. */
export function previewProfilePluginExport(
  name: string,
  cwd: string,
  input: unknown = { componentIds: [], textFileIds: [], includeInstruction: false },
): ProfilePluginExportSnapshot {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid Profile name");
  const selection = validateProfilePluginExportSelection(input);
  let profile;
  try {
    profile = readWorkspaceProfile(name);
  } catch {
    throw new Error("selected Profile definition is unavailable or invalid");
  }
  if (!profile) throw new Error("selected Profile is missing");
  if (profile.name !== name)
    throw new Error("Profile definition name does not match its selected directory");
  if (
    profile.skills.some(
      (name) => !name.split(":").every(safeSegment) || name.split(":").length > 2,
    ) ||
    profile.agents.some((name) => !safeSegment(name))
  )
    throw new Error("Profile static component references must be literal names, not private paths");
  const reader = new ProfileExportReader();
  let sources;
  try {
    sources = discoverProfileExportSources(profile, cwd, reader);
  } catch {
    throw new Error("static component sources are unavailable or exceed the bounded inventory");
  }
  const ids = new Set(sources.map((item) => item.component.id));
  if (selection.componentIds.some((id) => !ids.has(id)))
    throw new Error("selected component is not declared by this Profile");
  const selected = new Set(selection.componentIds);
  const selectedText = new Set(selection.textFileIds);
  const pluginName = `profile-${profile.name}`;
  const files: ProfilePluginExportFile[] = [];
  let totalBytes = 0;
  const add = (path: string, text: string) => {
    const bytes = Buffer.byteLength(text);
    if (
      !safeExportRelativePath(path) ||
      files.some((file) => file.path.toLowerCase() === path.toLowerCase())
    )
      throw new Error("export has an invalid or conflicting target path");
    if (
      bytes > LIMITS.textBytes ||
      totalBytes + bytes > LIMITS.bytes ||
      files.length >= LIMITS.files
    )
      throw new Error(
        "export exceeds 4 MiB / 256 files / 256 KiB per text file; nothing was written",
      );
    totalBytes += bytes;
    files.push({ path, text, bytes, sha256: createHash("sha256").update(text).digest("hex") });
  };
  const skills = new Map<string, string>();
  for (const item of sources.filter((item) => item.component.kind === "skill")) {
    const component = item.component;
    component.selected = selected.has(component.id);
    if (component.blocked) continue;
    const componentStart = files.length;
    const bytesBeforeComponent = totalBytes;
    try {
      const raw = staticSkill(item.raw, component.exportName);
      if (!component.selected) continue;
      discoverSupportText(item, reader);
      for (const file of component.textFiles) file.selected = selectedText.has(file.id);
      const support = component.textFiles
        .filter((file) => file.selected)
        .map((file) => {
          const source = item.support.get(file.id)!;
          if (!safeExportRelativePath(source.relativePath))
            throw new Error("selected supporting text has a non-portable or unsafe path");
          return {
            path: `skills/${component.exportName}/${source.relativePath}`,
            text: reader.read(item.root, source.path),
          };
        });
      // Build this component atomically in the snapshot; failed components never leave partial files.
      const componentFiles = [
        { path: `skills/${component.exportName}/SKILL.md`, text: raw },
        ...support,
      ];
      if (componentFiles.some((file) => Buffer.byteLength(file.text) > LIMITS.textBytes))
        throw new Error("component text exceeds 256 KiB");
      for (const file of componentFiles) add(file.path, file.text);
      skills.set(component.name, component.exportName);
    } catch (error) {
      files.splice(componentStart);
      totalBytes = bytesBeforeComponent;
      component.blocked =
        error instanceof Error && !("code" in error)
          ? error.message
          : "selected Skill source is unavailable or changed";
    }
  }
  for (const item of sources.filter((item) => item.component.kind === "agent")) {
    const component = item.component;
    component.selected = selected.has(component.id);
    if (component.blocked || !item.agent) continue;
    const agent = { ...item.agent, name: component.exportName };
    if (agent.mcp?.length)
      component.blocked =
        "Agent restricts MCP servers; this static package has no faithful MCP mapping";
    if (agent.tools?.some((tool) => tool.includes("mcp__")))
      component.blocked = "Agent MCP tool restrictions have no faithful static mapping";
    if (agent.skills !== undefined) {
      const mapped = agent.skills.map((skill) =>
        skills.get(item.pluginName && !skill.includes(":") ? `${item.pluginName}:${skill}` : skill),
      );
      if (mapped.some((skill) => skill === undefined))
        component.blocked =
          "Agent Skill allowlist references a missing, blocked, or unselected Skill";
      else agent.skills = mapped as string[];
    }
    if (component.selected && !component.blocked)
      add(`agents/${component.exportName}.md`, serializeAgentDefinition(agent));
  }
  const offeredText = new Set(
    sources.flatMap((item) => item.component.textFiles.map((file) => file.id)),
  );
  if (selection.textFileIds.some((id) => !offeredText.has(id)))
    throw new Error("supporting text selection is stale or not part of a selected Skill");
  const losses = [
    "CodeShell static plugin in CC directory layout. Only the existing CodeShell installer/loaders are verified; CC execution, Codex compatibility and equivalent Profile behavior are not promised.",
    "Review every selected text for secrets and private paths. Only explicitly selected static text is copied; scripts/assets and external references are not resolved.",
    "Profile activation, base preset, always-on instruction injection and host permission settings are not reproduced. Unspecified Agent allowlists keep their existing inherit semantics on the receiving host; explicit empty lists remain empty.",
    `Not exported: ${profile.plugins.length} plugin references, ${profile.mcp.length} MCP references, ${profile.requires?.skills.length ?? 0} Skill acquisition requirements, ${profile.requires?.tools.length ?? 0} external-tool requirements. No dependency is fetched or installed.`,
    `Source-access policy ${profile.sourceAccess === undefined ? "is absent" : "is omitted"}; exclusive-capability policy ${profile.exclusiveCapabilities ? "is omitted" : "is disabled"}. Review receiving-host permissions independently.`,
    "Portable memory, project experience, sessions, credentials, MCP arguments/environment/headers and source definitions are never included.",
    selection.includeInstruction
      ? "Main instruction is included only as docs/profile-instructions.md reference text; it is not injected or automatically loaded."
      : "Main instruction is omitted (default).",
    "Component names are mapped deterministically. References embedded in prose are not rewritten. CodeShell Agent tools/skills/mcp/sandbox fields may not impose the same constraints on other hosts; model/tool/sandbox availability depends on the receiving host.",
    "CC dynamic context markers and non-empty Skill allowed-tools pre-approval are blocked. CodeShell does not apply that Skill pre-approval; empty Skill policy is not a deny-tools guarantee. Real CC runtime behavior has not been tested. References: https://code.claude.com/docs/en/skills#inject-dynamic-context and https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill",
  ];
  const canExport =
    sources.some((item) => item.component.selected && !item.component.blocked) &&
    !sources.some((item) => item.component.selected && item.component.blocked);
  if (selection.includeInstruction && profile.mainInstruction)
    add("docs/profile-instructions.md", profile.mainInstruction);
  add(
    ".claude-plugin/plugin.json",
    `${JSON.stringify({ name: pluginName, version: "1.0.0", description: "Reviewed static CodeShell components (CC directory layout)" }, null, 2)}\n`,
  );
  add(
    "README.md",
    `# ${pluginName}\n\nA reviewed CodeShell static plugin (CC directory layout).\n\n${losses.map((loss) => `- ${loss}`).join("\n")}\n\nSee export-report.json for component mappings, exclusions and SHA-256 hashes. Import using the existing CodeShell local-plugin preview, then explicitly approve installation. Export does not install or activate anything.\n`,
  );
  const report = {
    schemaVersion: 1,
    format: "codeshell-cc-static-v1",
    profileName: name,
    pluginName,
    components: sources.map(({ component }) => ({
      kind: component.kind,
      name: component.name,
      exportName: component.exportName,
      source: component.source,
      selected: component.selected,
      blocked: component.blocked,
    })),
    losses,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    packageDigest: createHash("sha256")
      .update(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256])))
      .digest("hex"),
  };
  add("export-report.json", `${JSON.stringify(report, null, 2)}\n`);
  // A declaration or docs-only package is never an exportable result.
  return {
    format: "codeshell-cc-static-v1",
    profileName: name,
    pluginName,
    components: sources.map((item) => item.component),
    losses,
    files,
    totalBytes,
    canExport,
  };
}
