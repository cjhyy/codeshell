import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRegistry } from "../src/hooks/registry.js";
import { wrapHookMessages } from "../src/hooks/inject.js";
import { invalidateSkillCache } from "../src/skills/scanner.js";
import { createSuperpowersInjector } from "../src/hooks/builtin/superpowers-injector.js";
import { registerBuiltinHooks } from "../src/hooks/builtin/index.js";

const SKILL_BODY =
  "## Using Skills\nIf you think there is even a 1% chance a skill applies, USE IT.";

function writeFakePlugin(home: string, pluginName: string, skillDirName: string, body: string) {
  // Mimic the on-disk layout the scanner inspects:
  //   ~/.code-shell/plugins/installed_plugins.json (v2)
  //   <installPath>/skills/<dir>/SKILL.md
  const pluginsRoot = join(home, ".code-shell", "plugins");
  const installPath = join(pluginsRoot, "cache", pluginName, "local");
  const skillsDir = join(installPath, "skills", skillDirName);
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, "SKILL.md"),
    `---\ndescription: meta-skill\n---\n${body}`,
  );

  mkdirSync(pluginsRoot, { recursive: true });
  const manifest = {
    version: 2,
    plugins: {
      [`${pluginName}@skills`]: [
        {
          scope: "user",
          installPath,
          version: "local",
          installedAt: "2026-01-01T00:00:00Z",
          lastUpdated: "2026-01-01T00:00:00Z",
        },
      ],
    },
  };
  writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify(manifest));
}

describe("superpowers-injector handler", () => {
  let projectRoot: string;
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalStrict: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    projectRoot = mkdtempSync(join(tmpdir(), "sp-proj-"));
    fakeHome = mkdtempSync(join(tmpdir(), "sp-home-"));
    originalHome = process.env.HOME;
    originalStrict = process.env.CODESHELL_STRICT_SKILLS;
    process.env.HOME = fakeHome;
    delete process.env.CODESHELL_STRICT_SKILLS;
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalStrict !== undefined) process.env.CODESHELL_STRICT_SKILLS = originalStrict;
    else delete process.env.CODESHELL_STRICT_SKILLS;
  });

  it("on_session_start returns the SKILL.md body when superpowers:using-superpowers exists", () => {
    writeFakePlugin(fakeHome, "superpowers", "using-superpowers", SKILL_BODY);
    const { onSessionStart } = createSuperpowersInjector({ cwd: projectRoot });

    const result = onSessionStart({
      eventName: "on_session_start",
      data: { isSubAgent: false },
    });

    // HookHandler may return a Promise — but our impl is sync, so cast.
    const sync = result as { messages?: string[] };
    expect(sync.messages).toBeDefined();
    expect(sync.messages![0]).toContain("1% chance");
  });

  it("user_prompt_submit returns a one-line reminder when the meta-skill exists", () => {
    writeFakePlugin(fakeHome, "superpowers", "using-superpowers", SKILL_BODY);
    const { userPromptSubmit } = createSuperpowersInjector({ cwd: projectRoot });

    const result = userPromptSubmit({
      eventName: "user_prompt_submit",
      data: { isSubAgent: false },
    }) as { messages?: string[] };

    expect(result.messages).toBeDefined();
    expect(result.messages![0]).toContain("Skill");
  });

  it("returns no messages when the meta-skill is missing on disk", () => {
    // No plugin written — scanner finds nothing.
    const { onSessionStart, userPromptSubmit } = createSuperpowersInjector({
      cwd: projectRoot,
    });

    expect(
      (onSessionStart({ eventName: "on_session_start", data: {} }) as { messages?: string[] })
        .messages,
    ).toBeUndefined();
    expect(
      (userPromptSubmit({ eventName: "user_prompt_submit", data: {} }) as {
        messages?: string[];
      }).messages,
    ).toBeUndefined();
  });

  it("short-circuits when isSubAgent === true", () => {
    writeFakePlugin(fakeHome, "superpowers", "using-superpowers", SKILL_BODY);
    const { onSessionStart, userPromptSubmit } = createSuperpowersInjector({
      cwd: projectRoot,
    });

    const sessionResult = onSessionStart({
      eventName: "on_session_start",
      data: { isSubAgent: true },
    }) as { messages?: string[] };
    const turnResult = userPromptSubmit({
      eventName: "user_prompt_submit",
      data: { isSubAgent: true },
    }) as { messages?: string[] };

    expect(sessionResult.messages).toBeUndefined();
    expect(turnResult.messages).toBeUndefined();
  });
});

describe("registerBuiltinHooks", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let originalStrict: string | undefined;

  beforeEach(() => {
    invalidateSkillCache();
    fakeHome = mkdtempSync(join(tmpdir(), "sp-home-"));
    originalHome = process.env.HOME;
    originalStrict = process.env.CODESHELL_STRICT_SKILLS;
    process.env.HOME = fakeHome;
    delete process.env.CODESHELL_STRICT_SKILLS;
    writeFakePlugin(fakeHome, "superpowers", "using-superpowers", SKILL_BODY);
  });

  afterEach(() => {
    invalidateSkillCache();
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalStrict !== undefined) process.env.CODESHELL_STRICT_SKILLS = originalStrict;
    else delete process.env.CODESHELL_STRICT_SKILLS;
  });

  it("registers superpowers handlers when strictSkills=true", async () => {
    const hooks = new HookRegistry();
    registerBuiltinHooks(hooks, { cwd: process.cwd(), strictSkills: true });

    expect(hooks.hasHooks("on_session_start")).toBe(true);
    expect(hooks.hasHooks("user_prompt_submit")).toBe(true);

    const result = await hooks.emit("on_session_start", { isSubAgent: false });
    const wrapped = wrapHookMessages(result.messages);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.content).toContain("1% chance");
  });

  it("does NOT register handlers when strictSkills=false", () => {
    const hooks = new HookRegistry();
    registerBuiltinHooks(hooks, { cwd: process.cwd(), strictSkills: false });

    expect(hooks.hasHooks("on_session_start")).toBe(false);
    expect(hooks.hasHooks("user_prompt_submit")).toBe(false);
  });

  it("CODESHELL_STRICT_SKILLS=0 makes registered handlers no-op on emit", async () => {
    // ENV is now read at emit time (not registration), so handlers are
    // still registered but return {} when the kill-switch is on.
    process.env.CODESHELL_STRICT_SKILLS = "0";
    const hooks = new HookRegistry();
    registerBuiltinHooks(hooks, { cwd: process.cwd(), strictSkills: true });

    expect(hooks.hasHooks("on_session_start")).toBe(true);
    expect(hooks.hasHooks("user_prompt_submit")).toBe(true);

    const result = await hooks.emit("on_session_start", { isSubAgent: false });
    expect(result.messages).toBeUndefined();
  });

  it("ENV flip mid-process toggles handler output without re-registering", async () => {
    // Register with strictSkills=true under no ENV — handler returns messages.
    const hooks = new HookRegistry();
    registerBuiltinHooks(hooks, { cwd: process.cwd(), strictSkills: true });

    const before = await hooks.emit("on_session_start", { isSubAgent: false });
    expect(before.messages).toBeDefined();

    // Flip the kill-switch — next emit must be silent.
    process.env.CODESHELL_STRICT_SKILLS = "0";
    const after = await hooks.emit("on_session_start", { isSubAgent: false });
    expect(after.messages).toBeUndefined();

    // Flip back — handler resumes.
    process.env.CODESHELL_STRICT_SKILLS = "1";
    const again = await hooks.emit("on_session_start", { isSubAgent: false });
    expect(again.messages).toBeDefined();
  });
});
