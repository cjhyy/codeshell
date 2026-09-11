import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  promises as fs,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHubSkills, type HubSkillsOptions } from "./skills-management.js";
import { HubConfigurationError } from "./configuration.js";

const fixtures: { dir: string; server: Server; service: ReturnType<typeof createHubSkills> }[] = [];
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const THIRD = "3".repeat(40);
const md = (body = "Initial guidance.") =>
  `---\nname: hub-skill\ndescription: Imported fixture\n---\n${body}\n`;

afterEach(async () => {
  for (const { dir, server, service } of fixtures.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture(overrides: Partial<HubSkillsOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-skills-management-"));
  const cwd = join(dir, "workspace");
  const dataDir = join(dir, "data");
  mkdirSync(cwd);
  mkdirSync(dataDir);
  let commit = FIRST;
  let failDownload = false;
  let authorized = true;
  let clock = Date.now();
  let mutations = 0;
  const downloaded: string[] = [];
  const service = createHubSkills({
    cwd,
    dataDir,
    owner: async (req) =>
      typeof req.headers["x-device"] === "string" ? req.headers["x-device"] : null,
    isAuthorized: async () => authorized,
    now: () => clock,
    withMutation: async (write) => {
      mutations++;
      return write();
    },
    github: {
      inspect: async () => ({
        url: { owner: "fixture", repo: "skills", ref: "main" },
        defaultBranch: "main",
        commit,
        isPlugin: false,
        totalDetected: 1,
        skills: [
          {
            name: "hub-skill",
            description: "Imported fixture",
            pathInRepo: "skills/hub-skill/SKILL.md",
            dirInRepo: "skills/hub-skill",
          },
        ],
      }),
      commit: async () => commit,
      download: async (_info, ref, _dir, destination) => {
        downloaded.push(ref);
        if (failDownload) {
          await fs.writeFile(join(destination, "broken.txt"), "partial file");
          throw new Error("fixture failed download");
        }
        await fs.mkdir(join(destination, "scripts"));
        await fs.mkdir(join(destination, "assets"));
        await fs.writeFile(join(destination, "SKILL.md"), md(`Version ${ref}.`));
        await fs.writeFile(join(destination, "scripts", "run.sh"), "#!/bin/sh\nprintf imported\n", {
          mode: 0o700,
        });
        await fs.writeFile(join(destination, "assets", "data.txt"), `asset-${ref}`);
      },
    },
    ...overrides,
  });
  const server = createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  fixtures.push({ dir, server, service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function api(path = "", method = "GET", body?: unknown, device: string | null = "laptop") {
    const response = await fetch(url + "/api/v1/skills" + path, {
      method,
      headers: {
        ...(device ? { "x-device": device } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as any,
      headers: response.headers,
    };
  }
  const detail = () => api("/detail?name=hub-skill");
  async function imported() {
    const preview = await api("/github/preview", "POST", {
      url: "https://github.com/fixture/skills",
    });
    const install = await api("/github/install", "POST", {
      reviewToken: preview.body.reviewToken,
      pathInRepo: preview.body.skills[0].pathInRepo,
    });
    expect(install.status).toBe(201);
    return install;
  }
  return {
    dir,
    cwd,
    dataDir,
    service,
    api,
    detail,
    imported,
    downloaded,
    mutationCount: () => mutations,
    setCommit: (value: string) => {
      commit = value;
    },
    setFailure: (value: boolean) => {
      failDownload = value;
    },
    setAuthorized: (value: boolean) => {
      authorized = value;
    },
    advance: (value: number) => {
      clock += value;
    },
  };
}

describe("Hub Skills management", () => {
  test("authenticates discovery and creates, edits, and removes a workspace Skill with optimistic revisions", async () => {
    const f = await fixture();
    expect((await f.api("", "GET", undefined, null)).status).toBe(401);
    expect((await f.api("/local", "POST", { name: "hub-skill", content: md() })).status).toBe(201);
    const list = await f.api();
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.body.skills.find((skill: any) => skill.name === "hub-skill")).toMatchObject({
      editable: true,
      removable: true,
      source: "project",
    });
    const first = await f.detail();
    expect(first.body.content).toBe(md());
    expect(
      (
        await f.api("/local", "PUT", {
          name: "hub-skill",
          content: md("Edited."),
          revision: first.body.revision,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.api("/local", "PUT", {
          name: "hub-skill",
          content: md("Stale edit."),
          revision: first.body.revision,
        })
      ).status,
    ).toBe(409);
    const next = await f.detail();
    expect(next.body.content).toContain("Edited.");
    expect(
      (await f.api("/local", "DELETE", { name: "hub-skill", revision: next.body.revision })).status,
    ).toBe(200);
    expect((await f.detail()).status).toBe(404);
    expect(f.mutationCount()).toBe(4);
  });

  test("rejects paths and malformed markdown before a workspace installation becomes visible", async () => {
    const f = await fixture();
    for (const name of ["../escape", "/tmp/escape", "a/b", "a\\b", "..", "__proto__"])
      expect((await f.api("/local", "POST", { name, content: md() })).status).toBe(400);
    expect(
      (await f.api("/local", "POST", { name: "hub-skill", content: "---\nname: broken" })).status,
    ).toBe(400);
    expect(
      (
        await f.api("/local", "POST", {
          name: "hub-skill",
          content: "---\nname: one\nname: two\n---\nbody",
        })
      ).status,
    ).toBe(400);
    expect(existsSync(join(f.cwd, ".code-shell", "skills", "hub-skill"))).toBe(false);
    expect(
      (await f.api("/local", "POST", { name: "hub-skill", content: md(), path: "/arbitrary" }))
        .status,
    ).toBe(400);
  });

  test("does not follow linked workspace state roots or Skill bundle links", async () => {
    const f = await fixture();
    const outside = join(f.dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.cwd, ".code-shell"));
    expect((await f.api("/local", "POST", { name: "hub-skill", content: md() })).status).toBe(400);
    expect(existsSync(join(outside, "skills"))).toBe(false);
    rmSync(join(f.cwd, ".code-shell"));
    mkdirSync(join(f.cwd, ".code-shell", "skills"), { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), md());
    symlinkSync(outside, join(f.cwd, ".code-shell", "skills", "hub-skill"));
    const skill = (await f.api()).body.skills.find((item: any) => item.name === "hub-skill");
    expect(skill.editable).toBe(false);
    expect(skill.removable).toBe(false);
    expect(
      (await f.api("/local", "DELETE", { name: "hub-skill", revision: skill.revision })).status,
    ).toBe(400);
    expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe(md());
  });

  test("binds GitHub previews to their device and reviewed selection, then imports the pinned full bundle", async () => {
    const f = await fixture();
    const preview = await f.api("/github/preview", "POST", {
      url: "https://github.com/fixture/skills",
    });
    const request = {
      reviewToken: preview.body.reviewToken,
      pathInRepo: "skills/hub-skill/SKILL.md",
    };
    expect((await f.api("/github/install", "POST", request, "phone")).status).toBe(403);
    expect(
      (await f.api("/github/install", "POST", { ...request, pathInRepo: "other/SKILL.md" })).status,
    ).toBe(400);
    expect(f.downloaded).toEqual([]);
    f.setCommit(SECOND);
    expect((await f.api("/github/install", "POST", request)).status).toBe(201);
    expect(f.downloaded).toEqual([FIRST]);
    const skillDir = join(f.cwd, ".code-shell", "skills", "hub-skill");
    expect(readFileSync(join(skillDir, "assets", "data.txt"), "utf8")).toBe(`asset-${FIRST}`);
    expect(statSync(join(skillDir, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(skillDir, ".cs-skill-meta.json"), "utf8"))).toMatchObject({
      commit: FIRST,
      ref: "main",
      dirInRepo: "skills/hub-skill",
    });
    expect((await f.detail()).body.origin).toMatchObject({
      commit: FIRST,
      url: "https://github.com/fixture/skills",
    });
    expect((await f.api("/github/install", "POST", request)).status).toBe(409);
  });

  test("preserves the previous imported version on failed downloads and revision conflicts", async () => {
    const f = await fixture();
    await f.imported();
    const before = await f.detail();
    f.setCommit(SECOND);
    f.setFailure(true);
    expect(
      (
        await f.api("/github/update-preview", "POST", {
          name: "hub-skill",
          revision: before.body.revision,
        })
      ).status,
    ).toBe(400);
    expect((await f.detail()).body.revision).toBe(before.body.revision);
    f.setFailure(false);
    const preview = await f.api("/github/update-preview", "POST", {
      name: "hub-skill",
      revision: before.body.revision,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.changed).toBe(true);
    expect(
      (
        await f.api("/local", "PUT", {
          name: "hub-skill",
          content: md("New local work."),
          revision: before.body.revision,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.api("/github/update", "POST", { reviewToken: preview.body.reviewToken })).status,
    ).toBe(409);
    expect((await f.detail()).body.content).toContain("New local work.");
  });

  test("applies exactly the reviewed update and keeps scripts/assets/provenance coherent", async () => {
    const f = await fixture();
    await f.imported();
    f.setCommit(SECOND);
    const detail = await f.detail();
    const preview = await f.api("/github/update-preview", "POST", {
      name: "hub-skill",
      revision: detail.body.revision,
    });
    expect(preview.body.content).toContain(SECOND);
    expect(
      preview.body.files.some((file: any) => file.path === "scripts/run.sh" && file.executable),
    ).toBe(true);
    f.setCommit(THIRD);
    expect(
      (await f.api("/github/update", "POST", { reviewToken: preview.body.reviewToken })).status,
    ).toBe(200);
    expect(f.downloaded).toEqual([FIRST, SECOND]);
    const after = await f.detail();
    expect(after.body.content).toContain(SECOND);
    expect(after.body.origin.commit).toBe(SECOND);
    expect(
      readFileSync(join(f.cwd, ".code-shell", "skills", "hub-skill", "assets", "data.txt"), "utf8"),
    ).toBe(`asset-${SECOND}`);
    expect(
      (await f.api("/github/update", "POST", { reviewToken: preview.body.reviewToken })).status,
    ).toBe(409);
  });

  test("expires reviews and refuses mutations after device revocation", async () => {
    const f = await fixture();
    const preview = await f.api("/github/preview", "POST", {
      url: "https://github.com/fixture/skills",
    });
    f.advance(16 * 60_000);
    expect(
      (
        await f.api("/github/install", "POST", {
          reviewToken: preview.body.reviewToken,
          pathInRepo: "skills/hub-skill/SKILL.md",
        })
      ).status,
    ).toBe(409);
    f.setAuthorized(false);
    expect((await f.api("/local", "POST", { name: "hub-skill", content: md() })).status).toBe(401);
    expect(existsSync(join(f.cwd, ".code-shell", "skills", "hub-skill"))).toBe(false);
  });

  test("rechecks device authorization immediately before publishing after staging", async () => {
    let workspace = "";
    const f = await fixture({
      isAuthorized: async () => {
        const state = join(workspace, ".code-shell", "skills", ".skill-mutation");
        if (!existsSync(state)) return true;
        return !(await fs.readdir(state)).some((name) => name.startsWith(".skill-stage-"));
      },
    });
    workspace = f.cwd;
    expect((await f.api("/local", "POST", { name: "hub-skill", content: md() })).status).toBe(401);
    expect(existsSync(join(f.cwd, ".code-shell", "skills", "hub-skill"))).toBe(false);
    expect(
      (await fs.readdir(join(f.cwd, ".code-shell", "skills", ".skill-mutation"))).some((name) =>
        name.startsWith(".skill-stage-"),
      ),
    ).toBe(false);
  });

  test("honors the host's active-task guard and leaves the requested files unchanged", async () => {
    const f = await fixture({
      withMutation: async () => {
        throw new HubConfigurationError(409, "等待任务完成。");
      },
    });
    expect((await f.api("/local", "POST", { name: "hub-skill", content: md() })).status).toBe(409);
    expect(existsSync(join(f.cwd, ".code-shell", "skills", "hub-skill"))).toBe(false);
  });
});

function skillLifecycleGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Skills mutation lifecycle", () => {
  test("close during an authorization wait prevents a local skill commit", async () => {
    const ready = skillLifecycleGate();
    const resume = skillLifecycleGate();
    let checks = 0;
    const f = await fixture({
      isAuthorized: async () => {
        if (++checks === 2) {
          ready.resolve();
          await resume.promise;
        }
        return true;
      },
    });
    const pending = f.api("/local", "POST", { name: "hub-skill", content: md() });
    await ready.promise;
    await f.service.close();
    resume.resolve();
    expect((await pending).status).toBe(503);
    expect(existsSync(join(f.cwd, ".code-shell", "skills", "hub-skill"))).toBe(false);
  });

  test("revocation during reload hides the result of an already authorized Skill creation", async () => {
    const ready = skillLifecycleGate();
    const resume = skillLifecycleGate();
    let authorized = true;
    const f = await fixture({
      isAuthorized: async () => authorized,
      withMutation: async (write) => {
        const result = await write();
        ready.resolve();
        await resume.promise;
        return result;
      },
    });
    const pending = f.api("/local", "POST", { name: "hub-skill", content: md() });
    await ready.promise;
    authorized = false;
    resume.resolve();
    expect((await pending).status).toBe(401);
    expect(
      readFileSync(join(f.cwd, ".code-shell", "skills", "hub-skill", "SKILL.md"), "utf8"),
    ).toBe(md());
  });
});
