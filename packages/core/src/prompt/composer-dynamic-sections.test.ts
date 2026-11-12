import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptComposer, type ComposerOptions } from "./composer.js";
import { invalidateSkillCache, scanSkills } from "../skills/index.js";
import { buildSkillListing } from "../tool-system/builtin/skill-prompt.js";
import { MemoryManager } from "../session/memory.js";
import { joinContextListParts, planLedgerEmission } from "../context/context-ledger.js";

describe("PromptComposer.buildDynamicContextSections", () => {
  let cwd: string;
  let home: string;
  let prevHome: string | undefined;
  let prevCodeShellHome: string | undefined;
  const restoreEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const addSkill = (name: string, description: string): void => {
    const dir = join(cwd, ".code-shell", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    );
    invalidateSkillCache();
  };
  const options = (): ComposerOptions => ({
    cwd,
    model: "test-model",
    profileDeclaredSkills: ["missing-skill"],
    dynamicContextProviders: [() => "capability context"],
    sourcesContextProvider: () => "sources summary",
    goalToolState: { hasGoal: false },
  });

  beforeEach(() => {
    prevHome = process.env.HOME;
    cwd = mkdtempSync(join(tmpdir(), "cs-sections-"));
    home = mkdtempSync(join(tmpdir(), "cs-sections-home-"));
    prevCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.HOME = home;
    process.env.CODE_SHELL_HOME = join(home, ".code-shell");
    addSkill("alpha-skill", "first demo skill");
    addSkill("beta-skill", "second demo skill");
    const globalMemory = new MemoryManager();
    globalMemory.save({ name: "g1", description: "global fact", type: "user", content: "x" });
    const projectMemory = new MemoryManager({ projectDir: cwd });
    for (const name of ["p1", "p2", "p3", "p4"]) {
      projectMemory.save({ name, description: `project fact ${name}`, type: "user", content: "x" });
    }
  });
  afterEach(() => {
    restoreEnv("HOME", prevHome);
    restoreEnv("CODE_SHELL_HOME", prevCodeShellHome);
    invalidateSkillCache();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("sections are ordered and reproduce the dynamic-context message bytes", async () => {
    const composer = new PromptComposer(options());
    const sections = await composer.buildDynamicContextSections();
    expect(sections.map((section) => section.key)).toEqual([
      "skills",
      "skill-gap",
      "capability",
      "memory",
      "sources",
      "goal-tool",
    ]);

    const message = await composer.buildDynamicContextMessage();
    expect(message).toEqual({
      role: "user",
      content: `<system-reminder>\n${sections.map((s) => s.text).join("\n\n")}\n</system-reminder>`,
    });
    const snapshot = planLedgerEmission(sections, undefined);
    expect(snapshot.kind === "snapshot" && snapshot.text).toBe(String(message!.content));

    // Each section is exactly what the string renderers produce.
    const byKey = new Map(sections.map((section) => [section.key, section.text]));
    expect(byKey.get("skills")).toBe(
      buildSkillListing(scanSkills(cwd, {}), { declaredSkills: ["missing-skill"] }),
    );
    expect(byKey.get("memory")).toBe(MemoryManager.buildInjectionIndex({ projectDir: cwd }));
    expect(byKey.get("skill-gap")).toContain("missing-skill");
    expect(byKey.get("capability")).toBe("capability context");
    expect(byKey.get("sources")).toBe("sources summary");
    expect(byKey.get("goal-tool")).toContain("Goal 工具状态");
  });

  test("list sections reproduce their text from header, items and footer", async () => {
    const sections = await new PromptComposer(options()).buildDynamicContextSections();
    const skills = sections.find((section) => section.key === "skills")!;
    const memory = sections.find((section) => section.key === "memory")!;
    for (const section of [skills, memory]) {
      expect(section.header).toBeString();
      expect(section.footer).toBeString();
      expect(
        joinContextListParts({
          header: section.header!,
          items: section.items!,
          footer: section.footer!,
        }),
      ).toBe(section.text);
    }
    const entries = (items: typeof skills.items) =>
      items!.filter((item) => item.structural !== true).map((item) => item.id);
    expect(entries(skills.items)).toEqual(["alpha-skill", "beta-skill"]);
    // Within a layer the index follows directory order, so compare as a set.
    expect(entries(memory.items).sort()).toEqual([
      "global/user/g1",
      "project/user/p1",
      "project/user/p2",
      "project/user/p3",
      "project/user/p4",
    ]);
    for (const key of ["skill-gap", "capability", "sources", "goal-tool"]) {
      expect(sections.find((section) => section.key === key)!.items).toBeUndefined();
    }
  });

  test("the same state renders identical bytes", async () => {
    const first = await new PromptComposer(options()).buildDynamicContextSections();
    const second = await new PromptComposer(options()).buildDynamicContextSections();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(planLedgerEmission(second, planLedgerEmission(first, undefined).state).kind).toBe(
      "none",
    );
  });

  test("a new memory yields an update carrying only that memory", async () => {
    const before = await new PromptComposer(options()).buildDynamicContextSections();
    new MemoryManager({ projectDir: cwd }).save({
      name: "p5",
      description: "freshly learned",
      type: "user",
      content: "x",
    });
    const after = await new PromptComposer(options()).buildDynamicContextSections();
    const emission = planLedgerEmission(after, planLedgerEmission(before, undefined).state);
    expect(emission.kind).toBe("update");
    const text = emission.kind === "update" ? emission.text : "";
    expect(text).toContain(
      '<context-update section="memory">\n+ - [scope="user" location="project" type="user"] p5: freshly learned\n</context-update>',
    );
    expect(text).not.toContain("project fact p1");
    expect(text).not.toContain("Available Skills");
  });

  test("same-named memories get distinct, stable item ids", async () => {
    const projectMemory = new MemoryManager({ projectDir: cwd });
    projectMemory.save({ name: "p1", description: "a second p1", type: "user", content: "y" });
    const ids = async (): Promise<string[]> =>
      (await new PromptComposer(options()).buildDynamicContextSections())
        .find((section) => section.key === "memory")!
        .items!.map((item) => item.id);
    const first = await ids();
    expect(new Set(first).size).toBe(first.length);
    expect(first.filter((id) => id.startsWith("project/user/p1#")).length).toBe(2);
    expect(first).toContain("project/user/p2");
    expect(await ids()).toEqual(first);
  });

  test("empty sections are omitted and an empty context is null", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cs-sections-empty-"));
    process.env.HOME = empty;
    process.env.CODE_SHELL_HOME = join(empty, ".code-shell");
    invalidateSkillCache();
    try {
      const composer = new PromptComposer({ cwd: empty, model: "test-model" });
      expect(await composer.buildDynamicContextSections()).toEqual([]);
      expect(await composer.buildDynamicContextMessage()).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
