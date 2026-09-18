import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyPath } from "../path-policy.js";
import { collectSkillReadAccess } from "./skill-resources.js";
import { createSeatbeltBackend } from "./seatbelt.js";
import type { SandboxConfig } from "./index.js";

let home: string;
let oldHome: string | undefined;
let privateRoot: string;
let skillRoot: string;
let guide: string;
let config: SandboxConfig;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "cs-skill-sandbox-")));
  oldHome = process.env.HOME;
  process.env.HOME = home;
  privateRoot = join(home, ".code-shell");
  skillRoot = join(privateRoot, "skills", "example");
  mkdirSync(join(skillRoot, "references"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: example\ndescription: example\n---\n");
  guide = join(skillRoot, "references", "guide.md");
  writeFileSync(guide, "skill resource\nsecond line\n");
  for (const name of ["token.txt", "auth.json", ".env", "private.pem"]) {
    writeFileSync(join(skillRoot, "references", name), "CREDENTIAL_FIXTURE\n");
  }
  writeFileSync(join(privateRoot, "settings.json"), "PRIVATE_SETTINGS_FIXTURE\n");
  symlinkSync(join(privateRoot, "settings.json"), join(skillRoot, "references", "escape.md"));
  linkSync(join(privateRoot, "settings.json"), join(skillRoot, "references", "hardlink.md"));
  config = {
    mode: "seatbelt",
    writableRoots: [home],
    deniedReads: [privateRoot],
    network: "allow",
  };
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe("managed Skill sandbox inventory", () => {
  test("shares Read's registered Skill and credential boundaries", () => {
    const access = collectSkillReadAccess(config);
    expect(access.files).toContain(guide);
    expect(access.directories).toContain(join(skillRoot, "references"));
    expect(access.traversalDirectories).toContain(privateRoot);
    expect(access.directories).not.toContain(privateRoot);
    expect(access.files).not.toContain(join(privateRoot, "settings.json"));
    for (const name of [
      "token.txt",
      "auth.json",
      ".env",
      "private.pem",
      "escape.md",
      "hardlink.md",
    ]) {
      expect(access.files).not.toContain(join(skillRoot, "references", name));
    }
    for (const file of access.files) {
      expect(classifyPath(file, { workspaceRoot: home, operation: "read" }).decision).toBe("allow");
    }
  });

  test("custom parent, Skill, and file denies remain authoritative", () => {
    for (const denied of [home, skillRoot, guide]) {
      expect(
        collectSkillReadAccess({ ...config, deniedReads: [privateRoot, denied] }).files,
      ).not.toContain(guide);
    }
    expect(collectSkillReadAccess({ ...config, deniedReads: [] }).files).toEqual([]);
  });

  test("new resources and removal are reflected in the next command", () => {
    const added = join(skillRoot, "references", "added.md");
    expect(collectSkillReadAccess(config).files).not.toContain(added);
    writeFileSync(added, "added\n");
    expect(collectSkillReadAccess(config).files).toContain(added);
    rmSync(join(skillRoot, "SKILL.md"));
    expect(collectSkillReadAccess(config).files).toEqual([]);
  });

  test("only plugins registered inside the managed cache receive grants", () => {
    const pluginRoot = join(privateRoot, "plugins", "cache", "market", "plugin", "1.0.0");
    const pluginSkill = join(pluginRoot, "skills", "plugin-skill");
    mkdirSync(pluginSkill, { recursive: true });
    const manifest = join(pluginSkill, "SKILL.md");
    writeFileSync(manifest, "plugin skill\n");
    expect(collectSkillReadAccess(config).files).not.toContain(manifest);
    const registry = join(privateRoot, "plugins", "installed_plugins.json");
    const entry = {
      scope: "user",
      installPath: pluginRoot,
      version: "1.0.0",
      installedAt: "2026-09-12T00:00:00Z",
      lastUpdated: "2026-09-12T00:00:00Z",
    };
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: { "plugin@market": [entry] } }));
    expect(collectSkillReadAccess(config).files).toContain(manifest);
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: {} }));
    expect(collectSkillReadAccess(config).files).not.toContain(manifest);
  });
});

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function run(command: string, activeConfig = config) {
  const wrapped = createSeatbeltBackend(activeConfig).wrap(command, {
    cwd: home,
    shell: "/bin/bash",
  });
  try {
    return spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", timeout: 4000 });
  } finally {
    wrapped.cleanup?.();
  }
}

describe.if(process.platform === "darwin")("Skill reads through real Seatbelt", () => {
  test("cat, sed, grep and listing read registered resources", () => {
    for (const command of [
      `cat ${shellQuote(guide)}`,
      `sed -n '1p' ${shellQuote(guide)}`,
      `grep 'skill resource' ${shellQuote(guide)}`,
      `ls ${shellQuote(join(skillRoot, "references"))}`,
    ]) {
      const result = run(command);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    }
  });

  test("credentials, escaped links, private siblings and root listings stay blocked", () => {
    for (const target of [
      ...["token.txt", "auth.json", ".env", "private.pem", "escape.md", "hardlink.md"].map((name) =>
        join(skillRoot, "references", name),
      ),
      join(privateRoot, "settings.json"),
    ]) {
      const result = run(`cat ${shellQuote(target)}`);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("FIXTURE");
    }
    expect(run(`ls ${shellQuote(privateRoot)}`).status).not.toBe(0);
  });

  test("write access is not inherited from a broader writable workspace", () => {
    for (const command of [
      `echo changed > ${shellQuote(guide)}`,
      `echo changed > ${shellQuote(join(skillRoot, "new.md"))}`,
      `rm ${shellQuote(guide)}`,
    ])
      expect(run(command).status).not.toBe(0);
    expect(readFileSync(guide, "utf8")).toBe("skill resource\nsecond line\n");
  });

  test("an explicit file deny still blocks a registered reference", () => {
    const result = run(`cat ${shellQuote(guide)}`, {
      ...config,
      deniedReads: [privateRoot, guide],
    });
    expect(result.status).not.toBe(0);
  });

  test("literal profile paths handle quotes without widening access", () => {
    const unusual = join(skillRoot, 'quote"name.md');
    writeFileSync(unusual, "quoted resource\n");
    const result = run(`cat ${shellQuote(unusual)}`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("quoted resource\n");
  });

  test("noncanonical names fail closed when the runtime cannot resolve them", () => {
    const unusual = join(skillRoot, "back\\slash.md");
    writeFileSync(unusual, "resource\n");
    let resolvable = false;
    try {
      resolvable = realpathSync(unusual) === unusual;
    } catch {
      // Bun 1.3 on macOS cannot realpath a backslash in a filename; Node can.
    }
    expect(collectSkillReadAccess(config).files.includes(unusual)).toBe(resolvable);
    const result = run(`cat ${shellQuote(unusual)}`);
    expect(result.status === 0).toBe(resolvable);
    expect(run(`cat ${shellQuote(join(privateRoot, "settings.json"))}`).status).not.toBe(0);
  });

  test("a file swapped to a secret symlink after wrap cannot inherit a read grant", () => {
    const wrapped = createSeatbeltBackend(config).wrap(`cat ${shellQuote(guide)}`, {
      cwd: home,
      shell: "/bin/bash",
    });
    try {
      rmSync(guide);
      symlinkSync(join(privateRoot, "settings.json"), guide);
      const result = spawnSync(wrapped.file, wrapped.args, { encoding: "utf8", timeout: 4000 });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("PRIVATE_SETTINGS_FIXTURE");
    } finally {
      wrapped.cleanup?.();
    }
  });
});
