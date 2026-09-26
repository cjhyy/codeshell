import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { composeCapabilityModulesEnv } from "./capability-modules-env.js";

const urls = { coding: "file:///coding.js", arena: "file:///arena.js", pet: "file:///pet.js" };
const baseline =
  "file:///coding.js#createCodingModule,file:///arena.js#createArenaModule,file:///pet.js#createPetModule";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "optlab-desktop-modules-"));
  roots.push(root);
  return root;
}

const mustNotResolve = () => {
  throw new Error("disabled optimization lab must not resolve its package");
};

describe("composeCapabilityModulesEnv", () => {
  test("keeps the existing module order without resolving a default-off package", () => {
    expect(composeCapabilityModulesEnv(urls, {}, mustNotResolve)).toBe(baseline);
    expect(composeCapabilityModulesEnv(urls, { optimization_lab: false }, mustNotResolve)).toBe(
      baseline,
    );
  });

  test("appends the enabled module once and resolves it only for that spawn", () => {
    let resolutions = 0;
    const resolveLab = () => {
      resolutions += 1;
      return "file:///lab.js";
    };
    expect(composeCapabilityModulesEnv(urls, { optimization_lab: true }, resolveLab)).toBe(
      `${baseline},file:///lab.js#createOptimizationLabModule`,
    );
    expect(resolutions).toBe(1);
    expect(composeCapabilityModulesEnv(urls, { optimization_lab: false }, resolveLab)).toBe(
      baseline,
    );
    expect(resolutions).toBe(1);
  });
});

describe("readUserFeatureFlags", () => {
  async function readInSandbox(
    userFlags: Record<string, boolean> | undefined,
    projectFlags: Record<string, boolean>,
  ): Promise<{ flags: Record<string, boolean>; modules: string }> {
    const root = sandbox();
    const project = join(root, "project");
    const settingsDir = join(root, ".code-shell");
    const projectSettingsDir = join(project, ".code-shell");
    mkdirSync(projectSettingsDir, { recursive: true });
    if (userFlags !== undefined) {
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.json"),
        JSON.stringify({ featureFlags: userFlags }),
      );
    }
    writeFileSync(
      join(projectSettingsDir, "settings.json"),
      JSON.stringify({ featureFlags: projectFlags }),
    );
    writeFileSync(
      join(projectSettingsDir, "settings.local.json"),
      JSON.stringify({ featureFlags: projectFlags }),
    );
    const source = pathToFileURL(join(import.meta.dir, "capability-modules-env.ts")).href;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `import { readUserFeatureFlags, composeCapabilityModulesEnv } from ${JSON.stringify(source)};
         const flags = readUserFeatureFlags(${JSON.stringify(project)});
         const modules = composeCapabilityModulesEnv(${JSON.stringify(urls)}, flags, () => "file:///lab.js");
         console.log(JSON.stringify({ flags, modules }));`,
      ],
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        CODE_SHELL_HOME: settingsDir,
        CODE_SHELL_TEST_HOME: settingsDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(existsSync(join(settingsDir, "optimization-lab"))).toBe(false);
    return JSON.parse(output.trim());
  }

  test("ignores project and local opt-ins when user settings are absent", async () => {
    const result = await readInSandbox(undefined, { optimization_lab: true });
    expect(result.flags).toEqual({});
    expect(result.modules).toBe(baseline);
  });

  test("uses the user opt-in despite a project opt-out", async () => {
    const result = await readInSandbox({ optimization_lab: true }, { optimization_lab: false });
    expect(result.flags).toEqual({ optimization_lab: true });
    expect(result.modules).toBe(`${baseline},file:///lab.js#createOptimizationLabModule`);
  });

  test("keeps a user opt-out despite a project opt-in", async () => {
    const result = await readInSandbox({ optimization_lab: false }, { optimization_lab: true });
    expect(result.flags).toEqual({ optimization_lab: false });
    expect(result.modules).toBe(baseline);
  });
});
