import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewProfilePluginExport,
  saveWorkspaceProfile,
  previewLocalPlugin,
  installReviewedLocalPlugin,
} from "@cjhyy/code-shell-core/internal";
import {
  invalidateSkillCache,
  scanSkills,
  loadAgentDefinitionsForCwd,
} from "@cjhyy/code-shell-core";
import {
  ProfilePluginExportReviews,
  writeProfilePluginSnapshot,
} from "./profile-plugin-export-service.js";
import { resolveAgentTypeOverrides } from "../../../core/src/tool-system/builtin/agent.js";

let root: string, home: string, cwd: string;
let previous: Record<string, string | undefined>;
const envKeys = ["HOME", "USERPROFILE", "CODE_SHELL_HOME", "CODE_SHELL_TEST_HOME"];
const empty = { componentIds: [], textFileIds: [], includeInstruction: false };
const skillText =
  "---\nname: original\ndescription: Selected static Skill\nallowed-tools: []\n---\nREVIEWED_SKILL_BODY\n";
function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function skill(name = "chosen", raw = skillText, base = join(cwd, ".code-shell", "skills")) {
  put(join(base, name, "SKILL.md"), raw);
}
function agent(name: string, fields = "", base = join(cwd, ".code-shell", "agents")) {
  put(
    join(base, `${name}.md`),
    `---\nname: ${name}\ndescription: Selected agent\n${fields}---\nAGENT_BODY\n`,
  );
}
function profile(overrides: Record<string, unknown> = {}) {
  saveWorkspaceProfile({
    name: "exportable",
    label: "Exportable",
    basePreset: "general",
    skills: ["chosen"],
    agents: [],
    ...overrides,
  });
}
function choose(names?: string[], options = {}) {
  const offered = previewProfilePluginExport("exportable", cwd, empty);
  return previewProfilePluginExport("exportable", cwd, {
    ...empty,
    componentIds: offered.components
      .filter((item) => !names || names.includes(item.name))
      .map((item) => item.id),
    ...options,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codeshell-profile-plugin-"));
  home = join(root, "home");
  cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CODE_SHELL_HOME = join(home, ".code-shell");
  process.env.CODE_SHELL_TEST_HOME = process.env.CODE_SHELL_HOME;
  invalidateSkillCache();
  skill();
  profile();
});
afterEach(() => {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  invalidateSkillCache();
  rmSync(root, { recursive: true, force: true });
});

describe("reviewed static Profile plugin export", () => {
  test("HOME/USERPROFILE disagreement follows the original Skill and Agent loaders", () => {
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome);
    process.env.USERPROFILE = otherHome;
    skill(
      "user-selected",
      skillText.replace("REVIEWED_SKILL_BODY", "HOME_SKILL"),
      join(home, ".code-shell", "skills"),
    );
    skill(
      "user-selected",
      skillText.replace("REVIEWED_SKILL_BODY", "WRONG_USERPROFILE_SKILL"),
      join(otherHome, ".code-shell", "skills"),
    );
    agent("user-role", "tools: []\n", join(home, ".code-shell", "agents"));
    agent("user-role", "tools: [Write]\n", join(otherHome, ".code-shell", "agents"));
    profile({ skills: ["user-selected"], agents: ["user-role"] });
    const snapshot = choose();
    expect(snapshot.canExport).toBe(true);
    expect(snapshot.files.some((file) => file.text.includes("HOME_SKILL"))).toBe(true);
    expect(snapshot.files.some((file) => file.text.includes("WRONG_USERPROFILE"))).toBe(false);
    invalidateSkillCache();
    expect(scanSkills(cwd).find((item) => item.name === "user-selected")?.content).toContain(
      "HOME_SKILL",
    );
    expect(loadAgentDefinitionsForCwd(cwd).get("user-role")?.tools).toEqual([]);
  });
  test("requires explicit selection, a loadable component and matching Profile directory identity", () => {
    expect(previewProfilePluginExport("exportable", cwd, empty).canExport).toBe(false);
    profile({ skills: [], plugins: ["some-plugin"], mainInstruction: "reference only" });
    expect(choose(undefined, { includeInstruction: true }).canExport).toBe(false);
    put(
      join(home, ".code-shell", "profiles", "exportable", "profile.json"),
      JSON.stringify({ name: "other", label: "Other", basePreset: "general" }),
    );
    expect(() => choose()).toThrow("does not match");
  });
  test("invalid Profile errors do not disclose absolute paths or malformed secret input", () => {
    put(
      join(home, ".code-shell", "profiles", "exportable", "profile.json"),
      '{"PRIVATE_MALFORMED_SECRET":',
    );
    let caught: unknown;
    try {
      choose();
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("unavailable or invalid");
    expect(String(caught)).not.toContain(home);
    expect(String(caught)).not.toContain("PRIVATE_MALFORMED_SECRET");
  });

  test("reads actual local Skill priority and only explicitly selected supporting text", () => {
    skill(
      "chosen",
      skillText.replace("REVIEWED_SKILL_BODY", "LOW_PRIORITY"),
      join(cwd, ".agents", "skills"),
    );
    put(join(cwd, ".code-shell", "skills", "chosen", "notes.txt"), "OPTIONAL_TEXT");
    put(join(cwd, ".code-shell", "skills", "chosen", "script.js"), "NEVER_COPY_SCRIPT");
    const first = choose();
    expect(first.canExport).toBe(true);
    expect(first.files.some((file) => file.text.includes("REVIEWED_SKILL_BODY"))).toBe(true);
    expect(first.files.some((file) => file.text.includes("OPTIONAL_TEXT"))).toBe(false);
    expect(first.components[0].textFiles.map((file) => file.path)).toEqual(["notes.txt"]);
    const second = choose(undefined, {
      textFileIds: first.components[0].textFiles.map((file) => file.id),
    });
    expect(second.files.some((file) => file.text.includes("OPTIONAL_TEXT"))).toBe(true);
    expect(second.files.some((file) => file.text.includes("NEVER_COPY_SCRIPT"))).toBe(false);
  });

  test("preserves absent versus empty allowlists and remaps only selected Skill references", () => {
    agent("default");
    agent("deny", "tools: []\nskills: []\nmcp: []\n");
    agent("limited", "tools: [Read]\nskills: [chosen]\nmcp: []\nsandbox: auto\n");
    profile({ agents: ["default", "deny", "limited"] });
    const snapshot = choose();
    expect(snapshot.canExport).toBe(true);
    const output = (name: string) =>
      snapshot.files.find(
        (file) =>
          file.path ===
          `agents/${snapshot.components.find((item) => item.name === name)!.exportName}.md`,
      )!.text;
    expect(output("default")).not.toContain("tools:");
    expect(output("default")).not.toContain("skills:");
    expect(output("default")).not.toContain("mcp:");
    expect(output("deny")).toContain("tools: []");
    expect(output("deny")).toContain("skills: []");
    expect(output("deny")).toContain("mcp: []");
    expect(output("limited")).toContain(snapshot.components[0].exportName);
    expect(
      choose(["limited"]).components.find((item) => item.name === "limited")!.blocked,
    ).toContain("unselected Skill");
  });

  test.each([
    "mcp: [private-server]\n",
    "tools: [mcp__private__read]\n",
    "tools: null\n",
    "skills: [42]\n",
    "permissionMode: bypassPermissions\n",
    "hooks: {}\n",
  ])("blocks unrepresentable Agent policy %s", (fields) => {
    agent("unsafe", fields);
    profile({ agents: ["unsafe"] });
    const snapshot = choose();
    expect(snapshot.canExport).toBe(false);
    expect(snapshot.components.find((item) => item.name === "unsafe")!.blocked).toBeTruthy();
    expect(snapshot.files.some((file) => file.path.startsWith("agents/"))).toBe(false);
  });

  test("blocks missing/conflicting names and unknown Skill execution/policy fields", () => {
    agent("conflict");
    agent("conflict", "", join(home, ".code-shell", "agents"));
    skill("unsafe", skillText.replace("allowed-tools: []", "hooks: {}"));
    profile({ skills: ["chosen", "missing", "unsafe"], agents: ["conflict", "missing-agent"] });
    const snapshot = choose();
    expect(snapshot.canExport).toBe(false);
    expect(snapshot.components.filter((item) => item.blocked)).toHaveLength(4);
    expect(snapshot.components.find((item) => item.name === "conflict")!.blocked).toContain(
      "multiple Agent",
    );
  });
  test.each([
    "inline !`echo NEVER_EXECUTE`",
    "```!\necho NEVER_EXECUTE\n```",
    "~~~!\necho NEVER_EXECUTE\n~~~",
    "literal example of !`command`",
  ])("blocks dynamic CC Skill context without executing or deleting text: %s", (body) => {
    skill("chosen", skillText.replace("REVIEWED_SKILL_BODY", body));
    const snapshot = choose();
    expect(snapshot.canExport).toBe(false);
    expect(snapshot.components[0].blocked).toContain("dynamic command marker");
    expect(snapshot.files.some((file) => file.path.endsWith("SKILL.md"))).toBe(false);
  });
  test.each(["[Read]", "Read, Write", "[mcp__private__read]"])(
    "blocks non-empty Skill pre-approved tool grants %s",
    (policy) => {
      skill("chosen", skillText.replace("allowed-tools: []", `allowed-tools: ${policy}`));
      const snapshot = choose();
      expect(snapshot.canExport).toBe(false);
      expect(snapshot.components[0].blocked).toContain("pre-approve");
    },
  );
  test.each(["[]", '""'])(
    "retains empty Skill policy %s without a deny-tools promise",
    (policy) => {
      skill("chosen", skillText.replace("allowed-tools: []", `allowed-tools: ${policy}`));
      const snapshot = choose();
      expect(snapshot.canExport).toBe(true);
      expect(snapshot.files.find((file) => file.path.endsWith("SKILL.md"))?.text).toContain(
        `allowed-tools: ${policy}`,
      );
      expect(snapshot.losses.join(" ")).toContain("not a deny-tools guarantee");
    },
  );
  test.skipIf(process.platform === "win32")(
    "qualified Skill collision cannot silently substitute a plugin for the runtime's local Skill",
    () => {
      skill("p:x", skillText.replace("REVIEWED_SKILL_BODY", "ACTUAL_LOCAL_LITERAL"));
      const plugin = join(root, "plugin");
      skill(
        "x",
        skillText.replace("REVIEWED_SKILL_BODY", "DIFFERENT_PLUGIN_BODY"),
        join(plugin, "skills"),
      );
      put(
        join(home, ".code-shell", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "p@local": [
              {
                scope: "user",
                installPath: plugin,
                version: "1.0.0",
                installedAt: "fixture",
                lastUpdated: "fixture",
              },
            ],
          },
        }),
      );
      profile({ skills: ["p:x"] });
      invalidateSkillCache();
      expect(scanSkills(cwd).find((item) => item.name === "p:x")?.content).toContain(
        "ACTUAL_LOCAL_LITERAL",
      );
      const snapshot = choose();
      expect(snapshot.canExport).toBe(false);
      expect(snapshot.components[0].blocked).toContain("local literal directory");
      expect(snapshot.files.some((file) => file.text.includes("DIFFERENT_PLUGIN_BODY"))).toBe(
        false,
      );
    },
  );

  test("loss report omits memory, credentials, original MCP/source definitions and private source paths", () => {
    const sentinel = "PRIVATE_MEMORY_CREDENTIAL_SENTINEL";
    put(join(home, ".code-shell", "profiles", "exportable", "MEMORY.md"), sentinel);
    put(join(home, ".code-shell", "credentials.json"), sentinel);
    profile({
      plugins: [sentinel],
      mcp: [sentinel],
      portableMemory: true,
      exclusiveCapabilities: true,
      sourceAccess: [],
      mainInstruction: "INSTRUCTION_REFERENCE",
    });
    const snapshot = choose();
    const bytes = JSON.stringify(snapshot);
    expect(bytes).not.toContain(sentinel);
    expect(bytes).not.toContain(home);
    expect(bytes).not.toContain(cwd);
    expect(bytes).not.toContain("INSTRUCTION_REFERENCE");
    expect(snapshot.losses.join(" ")).toContain("Source-access policy is omitted");
    const reference = choose(undefined, { includeInstruction: true });
    expect(reference.files.find((file) => file.path === "docs/profile-instructions.md")?.text).toBe(
      "INSTRUCTION_REFERENCE",
    );
    expect(
      reference.files.filter((file) => file.text.includes("INSTRUCTION_REFERENCE")),
    ).toHaveLength(1);
  });

  test("rejects symlink components, parent escapes, oversized/invalid UTF-8 text and unbounded inventories", () => {
    const path = join(cwd, ".code-shell", "skills", "chosen", "SKILL.md");
    rmSync(path);
    symlinkSync(join(root, "outside.md"), path);
    put(join(root, "outside.md"), skillText);
    expect(choose().canExport).toBe(false);
    rmSync(path);
    put(path, "x".repeat(256 * 1024 + 1));
    expect(choose().canExport).toBe(false);
    writeFileSync(path, Buffer.from([0xff, 0xfe]));
    expect(choose().canExport).toBe(false);
    skill();
    for (let i = 0; i < 257; i++)
      put(join(cwd, ".code-shell", "skills", "chosen", `note-${i}.txt`), "bounded");
    expect(choose().canExport).toBe(false);
    expect(() => previewProfilePluginExport("../escape", cwd)).toThrow("invalid Profile");
    expect(() => choose(undefined, { textFileIds: ["a".repeat(64)] })).toThrow(
      "selection is stale",
    );
  });

  test("private review owner/context/cancel/replacement fences and immutable reviewed bytes", () => {
    const offered = choose();
    const selection = { ...empty, componentIds: offered.components.map((item) => item.id) };
    const reviews = new ProfilePluginExportReviews();
    const preview = reviews.preview(1, "context-a", "exportable", cwd, selection);
    expect(() => reviews.get(2, "context-a", preview.reviewToken)).toThrow("expired");
    expect(() => reviews.get(1, "context-b", preview.reviewToken)).toThrow("context changed");
    expect(() =>
      reviews.commit(1, "context-a", preview.reviewToken, false, join(root, "not-written")),
    ).toThrow("explicit acceptance");
    expect(existsSync(join(root, "not-written"))).toBe(false);
    skill("chosen", skillText.replace("REVIEWED_SKILL_BODY", "REPLACED_AFTER_REVIEW"));
    const output = join(root, "reviewed.plugin");
    reviews.commit(1, "context-a", preview.reviewToken, true, output);
    const exported = readFileSync(
      join(output, "skills", offered.components[0].exportName, "SKILL.md"),
      "utf8",
    );
    expect(exported).toContain("REVIEWED_SKILL_BODY");
    expect(exported).not.toContain("REPLACED_AFTER_REVIEW");
    expect(() => reviews.get(1, "context-a", preview.reviewToken)).toThrow("expired");
    const stale = reviews.preview(1, "context-a", "exportable", cwd, selection);
    const current = reviews.preview(1, "context-a", "exportable", cwd, selection);
    expect(() => reviews.get(1, "context-a", stale.reviewToken)).toThrow("expired");
    reviews.cancel(1, current.reviewToken);
    expect(() => reviews.get(1, "context-a", current.reviewToken)).toThrow("expired");
  });

  test("aggregate source/output budgets fail explicitly without a truncated export", () => {
    const names = Array.from({ length: 17 }, (_, index) => `large-${index}`);
    for (const name of names)
      skill(name, `---\nname: ${name}\ndescription: Large text\n---\n${"x".repeat(250 * 1024)}`);
    profile({ skills: names });
    const snapshot = choose();
    expect(snapshot.canExport).toBe(false);
    expect(snapshot.components.some((item) => item.blocked?.includes("4 MiB"))).toBe(true);
    expect(snapshot.totalBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(() => writeProfilePluginSnapshot(snapshot, join(root, "truncated"))).toThrow("loadable");
    expect(existsSync(join(root, "truncated"))).toBe(false);
  });

  test("never overwrites an existing empty directory and rolls back only owned files on failure", () => {
    const snapshot = choose();
    const output = join(root, "existing");
    mkdirSync(output);
    expect(() => writeProfilePluginSnapshot(snapshot, output)).toThrow();
    expect(readdirSync(output)).toEqual([]);
    const bad = {
      ...snapshot,
      files: [
        ...snapshot.files,
        { path: "bad.txt", text: "bad", bytes: 3, sha256: "0".repeat(64) },
      ],
    };
    expect(() => writeProfilePluginSnapshot(bad, join(root, "failed"))).toThrow("export failed");
    expect(existsSync(join(root, "failed"))).toBe(false);
    expect(() =>
      writeProfilePluginSnapshot({ ...snapshot, canExport: false }, join(root, "shell")),
    ).toThrow("loadable");
    expect(existsSync(join(root, "shell"))).toBe(false);
  });

  test("real directory export → installer preview → explicit install → original Skill/Agent loaders", async () => {
    agent("default");
    agent("deny", "tools: []\nskills: []\nmcp: []\n");
    agent("limited", "skills: [chosen]\nmcp: []\n");
    profile({ agents: ["default", "deny", "limited"] });
    const snapshot = choose();
    const output = join(root, "static.plugin");
    writeProfilePluginSnapshot(snapshot, output);
    expect(existsSync(join(home, ".code-shell", "plugins", "installed_plugins.json"))).toBe(false);
    const preview = await previewLocalPlugin({ kind: "dir", path: output });
    expect(preview.format).toBe("cc");
    expect(preview.skills).toHaveLength(1);
    expect(preview.agents).toHaveLength(3);
    expect(preview.hooks).toEqual([]);
    expect(preview.mcpServers).toEqual([]);
    expect(existsSync(join(home, ".code-shell", "plugins", "installed_plugins.json"))).toBe(false);
    await installReviewedLocalPlugin(
      { kind: "dir", path: output },
      preview.reviewToken,
      "2026-10-09T00:00:00.000Z",
    );
    invalidateSkillCache();
    const loadedSkill = scanSkills(cwd).find(
      (item) => item.name === `${snapshot.pluginName}:${snapshot.components[0].exportName}`,
    );
    expect(loadedSkill?.content).toContain("REVIEWED_SKILL_BODY");
    const agents = loadAgentDefinitionsForCwd(cwd);
    const get = (name: string) =>
      agents.get(snapshot.components.find((item) => item.name === name)!.exportName)!;
    expect(get("default").tools).toBeUndefined();
    expect(get("default").skills).toBeUndefined();
    expect(get("default").mcp).toBeUndefined();
    expect(get("deny").tools).toEqual([]);
    expect(get("deny").skills).toEqual([]);
    expect(get("deny").mcp).toEqual([]);
    expect(get("limited").skills).toEqual([snapshot.components[0].exportName]);
    expect(get("limited").pluginName).toBe(snapshot.pluginName);
    expect(resolveAgentTypeOverrides(get("limited").name, agents).skillAllowlist).toEqual([
      `${snapshot.pluginName}:${snapshot.components[0].exportName}`,
    ]);
    expect(resolveAgentTypeOverrides(get("deny").name, agents).toolAllowlist).toEqual([]);
    expect(resolveAgentTypeOverrides(get("deny").name, agents).skillAllowlist).toEqual([]);
    expect(resolveAgentTypeOverrides(get("deny").name, agents).mcpAllowlist).toEqual([]);
    expect(resolveAgentTypeOverrides(get("default").name, agents).skillAllowlist).toBeUndefined();
  });
});
