import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./auth.js";
import {
  applySkillUpdate,
  createSkill,
  editSkill,
  installGithubSkill,
  newSkillContent,
  previewGithubSkills,
  readManagedSkill,
  removeSkill,
  validSkillName,
  visibleSkills,
} from "./skills-management.js";

const nativeFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = nativeFetch;
});

test("Skill editor sends exact content and revision without an arbitrary server path", async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (path, init) => {
    requests.push({ path: String(path), init: init! });
    return Response.json({ ok: true, name: "demo", message: "saved" });
  }) as typeof fetch;
  await createSkill("demo", "---\nname: demo\n---\n$literal `markdown`\n");
  await editSkill("demo", "Edited body\n", "a".repeat(64));
  await removeSkill("demo", "b".repeat(64));
  expect(requests.map((entry) => entry.init.method)).toEqual(["POST", "PUT", "DELETE"]);
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
    name: "demo",
    content: "---\nname: demo\n---\n$literal `markdown`\n",
  });
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({
    name: "demo",
    content: "Edited body\n",
    revision: "a".repeat(64),
  });
  for (const entry of requests) {
    expect(entry.path).toBe("/api/v1/skills/local");
    expect(entry.init.credentials).toBe("same-origin");
    expect(entry.init.cache).toBe("no-store");
  }
});

test("GitHub installation and update submit only server-issued review tokens", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  await previewGithubSkills(" https://github.com/fixture/skills ");
  await installGithubSkill("review-token", "skills/demo/SKILL.md", " demo ");
  await applySkillUpdate("update-token");
  expect(bodies).toEqual([
    { url: "https://github.com/fixture/skills" },
    { reviewToken: "review-token", pathInRepo: "skills/demo/SKILL.md", name: "demo" },
    { reviewToken: "update-token" },
  ]);
});

test("keeps authentication and stale-edit errors actionable", async () => {
  globalThis.fetch = (async () =>
    Response.json({ error: "Skill 已发生变化，请刷新。" }, { status: 409 })) as typeof fetch;
  await expect(editSkill("demo", "body", "revision")).rejects.toMatchObject({ status: 409 });
  globalThis.fetch = (async () =>
    Response.json({ error: "登录已失效" }, { status: 401 })) as typeof fetch;
  await expect(readManagedSkill("demo")).rejects.toBeInstanceOf(ApiError);
});

test("encodes names and rejects mismatched detail responses", async () => {
  let requested = "";
  globalThis.fetch = (async (path) => {
    requested = String(path);
    return Response.json({ name: "wrong", content: "wrong", revision: "x" });
  }) as typeof fetch;
  await expect(readManagedSkill("plugin:skill /?")).rejects.toThrow("读取失败");
  expect(requested).toBe("/api/v1/skills/detail?name=plugin%3Askill%20%2F%3F");
});

test("supports useful creation defaults and source-aware search", () => {
  expect(newSkillContent("my-skill")).toContain("name: my-skill");
  for (const name of ["demo", "local.skill", "local_skill", "my-skill"])
    expect(validSkillName(name)).toBe(true);
  for (const name of ["../escape", "a/b", "name..bad", "", "a\\b"])
    expect(validSkillName(name)).toBe(false);
  const skills = [
    {
      name: "local",
      description: "Review code",
      source: "project",
      enabled: true,
      editable: true,
      removable: true,
      revision: "x",
    },
    {
      name: "plugin:review",
      description: "Review documents",
      source: "plugin",
      enabled: false,
      editable: false,
      removable: false,
      revision: "y",
    },
  ] as const;
  expect(visibleSkills([...skills], "review", "project").map((skill) => skill.name)).toEqual([
    "local",
  ]);
});
