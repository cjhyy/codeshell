import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { listSkills, readSkillBody } from "./skills-service.js";
import { createHubSkills } from "../../../server/src/hub/skills-management.js";
import { _resetCodeShellMarkdownPathAllowlistForTests } from "./safe-read.js";
import { invalidateSkillCache } from "@cjhyy/code-shell-core";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  invalidateSkillCache();
  _resetCodeShellMarkdownPathAllowlistForTests();
});
function put(file: string, content: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}
function skill(root: string, name: string) {
  const file = join(root, name, "SKILL.md");
  put(file, `---\nname: ${name}\ndescription: Fixture skill\n---\nfixture body\n`);
  return file;
}

test("Desktop and Hub share effective toggles and project bindings, retaining independent grants", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-skills-"));
  const previous = process.env.HOME;
  process.env.HOME = join(dir, "home");
  cleanup.push(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const home = process.env.HOME;
  const cwd = join(dir, "one"),
    other = join(dir, "two");
  mkdirSync(other);
  const user = skill(join(home, ".code-shell", "skills"), "user-skill");
  skill(join(cwd, ".code-shell", "skills"), "local");
  const pluginRoot = join(home, ".code-shell", "plugins", "cache", "fixture");
  const plugin = skill(join(pluginRoot, "skills"), "plugin-skill");
  put(join(home, ".code-shell", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "fixture@mkt": [
        {
          scope: "user",
          installPath: pluginRoot,
          version: "1",
          installedAt: "t",
          lastUpdated: "t",
        },
      ],
    },
  });
  const app = join(home, ".code-shell", "panel-apps", "design");
  skill(join(app, "agent", "skills"), "repo-design");
  put(join(app, ".codeshell-panel", "panel.json"), {
    schemaVersion: 2,
    id: "design",
    version: "1.0.0",
    title: { default: "Design" },
    entry: "app/index.html",
    permissions: [],
    agent: { tools: [], skills: ["agent/skills/repo-design/SKILL.md"] },
  });
  put(join(home, ".code-shell", "panel-apps", "installed.json"), {
    version: 1,
    apps: [{ id: "design" }],
  });
  put(join(home, ".code-shell", "settings.json"), {
    disabledSkills: ["user-skill"],
    disabledPlugins: ["fixture"],
  });
  put(join(cwd, ".code-shell", "settings.json"), {
    panelAppBindings: ["design"],
    capabilityOverrides: { skills: { "user-skill": "on", local: "off" } },
  });
  const hub = (workspace: string) => {
    const service = createHubSkills({
      cwd: workspace,
      dataDir: join(dir, "hub"),
      owner: async () => "fixture",
      isAuthorized: async () => true,
    });
    cleanup.push(() => service.close());
    return service;
  };
  const first = hub(cwd),
    second = hub(other);
  for (const [workspace, service] of [
    [cwd, first],
    [other, second],
  ] as const) {
    const desktop = listSkills(workspace, { includeDisabled: true });
    expect(desktop.map(({ name, source, enabled }) => ({ name, source, enabled }))).toEqual(
      service.snapshot().skills.map(({ name, source, enabled }) => ({ name, source, enabled })),
    );
    expect(listSkills(workspace).map((entry) => entry.name)).toEqual(
      desktop.filter((entry) => entry.enabled).map((entry) => entry.name),
    );
  }
  expect(first.snapshot().skills).toContainEqual(
    expect.objectContaining({ name: "user-skill", enabled: true }),
  );
  expect(second.snapshot().skills).toContainEqual(
    expect.objectContaining({ name: "user-skill", enabled: false }),
  );
  expect(first.snapshot().skills).toContainEqual(
    expect.objectContaining({ name: "fixture:plugin-skill", enabled: false }),
  );
  expect(first.snapshot().skills.some((entry) => entry.name === "design:repo-design")).toBe(true);
  expect(second.snapshot().skills.some((entry) => entry.name === "design:repo-design")).toBe(false);
  const unlisted = skill(join(dir, "unlisted", ".code-shell", "skills"), "secret");
  await expect(readSkillBody(unlisted)).rejects.toThrow();
  expect(await readSkillBody(user)).toContain("fixture body");
  // Exercise the production mutation adapter with an authenticated in-memory HTTP request.
  for (const [name, file] of [
    ["user-skill", user],
    ["fixture:plugin-skill", plugin],
  ]) {
    const before = readFileSync(file!);
    for (const method of ["PUT", "DELETE"]) {
      const req = Object.assign(
        Readable.from([
          JSON.stringify({
            name,
            revision: first.snapshot().skills.find((entry) => entry.name === name)!.revision,
            ...(method === "PUT" ? { content: "---\ndescription: Fixture\n---\nchanged" } : {}),
          }),
        ]),
        { url: "/api/v1/skills/local", method, headers: { "content-type": "application/json" } },
      );
      let status = 0;
      const res = {
        headersSent: false,
        destroyed: false,
        writeHead: (value: number) => {
          status = value;
        },
        end: () => {},
      };
      expect(await first.handle(req as any, res as any)).toBe(true);
      expect(status).toBe(403);
      expect(readFileSync(file!)).toEqual(before);
    }
  }
});

test("Hub revision and mutation authorization still fence shared inventory results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-skill-mutations-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = skill(join(dir, ".code-shell", "skills"), "editable");
  let authorized = true;
  let revoke: "none" | "before" | "after" = "none";
  const hub = createHubSkills({
    cwd: dir,
    dataDir: join(dir, "hub"),
    owner: async () => "fixture",
    isAuthorized: async () => authorized,
    withMutation: async (write) => {
      if (revoke === "before") authorized = false;
      const result = await write();
      if (revoke === "after") authorized = false;
      return result;
    },
  });
  cleanup.push(() => hub.close());
  const revision = () => hub.snapshot().skills.find((entry) => entry.name === "editable")!.revision;
  const put = async (expected: string, body: string) => {
    const req = Object.assign(
      Readable.from([
        JSON.stringify({
          name: "editable",
          revision: expected,
          content: `---\ndescription: Fixture\n---\n${body}\n`,
        }),
      ]),
      {
        url: "/api/v1/skills/local",
        method: "PUT",
        headers: { "content-type": "application/json" },
      },
    );
    let status = 0,
      response = "";
    const res = {
      headersSent: false,
      destroyed: false,
      writeHead: (value: number) => {
        status = value;
      },
      end: (value: string) => {
        response = value;
      },
    };
    expect(await hub.handle(req as any, res as any)).toBe(true);
    return { status, body: JSON.parse(response) };
  };
  const first = revision();
  expect((await put(first, "updated")).status).toBe(200);
  const updated = readFileSync(file);
  expect(revision()).not.toBe(first);
  expect((await put(first, "stale")).status).toBe(409);
  expect(readFileSync(file)).toEqual(updated);
  revoke = "before";
  expect((await put(revision(), "revoked before write")).status).toBe(401);
  expect(readFileSync(file)).toEqual(updated);
  authorized = true;
  revoke = "after";
  const hidden = await put(revision(), "authorized then revoked");
  expect(hidden.status).toBe(401);
  expect(hidden.body.revision).toBeUndefined();
  expect(readFileSync(file, "utf8")).toContain("authorized then revoked");
  authorized = true;
  revoke = "none";
  await hub.close();
  const closed = readFileSync(file);
  expect((await put(revision(), "closed")).status).toBe(503);
  expect(readFileSync(file)).toEqual(closed);
});
