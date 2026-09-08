import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  downloadSkillTree,
  inspectRepo,
  parseSkillSourceMeta,
  updateSkillFromSource,
  SKILL_META_FILE,
} from "./github.js";

const nativeFetch = globalThis.fetch;
const directories: string[] = [];
const commit = "a".repeat(40);
afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "github-skill-download-"));
  directories.push(dir);
  return dir;
}

test("GitHub preview pins tree and markdown to the reviewed immutable commit", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input, options) => {
    const url = String(input);
    requests.push(url);
    expect(options?.redirect).toBe("error");
    if (url.endsWith("/repos/fixture/skills")) return Response.json({ default_branch: "main" });
    if (url.endsWith("/commits/main")) return Response.json({ sha: commit });
    if (url.includes("/git/trees/")) {
      expect(url).toContain(`/git/trees/${commit}?`);
      return Response.json({
        tree: [
          { path: "SKILL.md", type: "blob", sha: "blob" },
          { path: "assets/example.txt", type: "blob", sha: "asset" },
        ],
      });
    }
    expect(url).toBe(`https://raw.githubusercontent.com/fixture/skills/${commit}/SKILL.md`);
    return new Response("---\nname: example\ndescription: A fixture\n---\nInstructions.\n");
  }) as typeof fetch;
  const preview = await inspectRepo("https://github.com/fixture/skills");
  expect(preview.commit).toBe(commit);
  expect(preview.skills).toHaveLength(1);
  expect(preview.skills[0]).toMatchObject({
    name: "example",
    dirInRepo: "",
    pathInRepo: "SKILL.md",
  });
  expect(requests).toHaveLength(4);
});

test("root Skill bundles include their assets and preserve executable modes", async () => {
  const target = directory();
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/git/trees/"))
      return Response.json({
        tree: [
          { path: "SKILL.md", type: "blob", sha: "skill", mode: "100644" },
          { path: "scripts/run.sh", type: "blob", sha: "script", mode: "100755" },
          { path: "assets/example.txt", type: "blob", sha: "asset", mode: "100644" },
        ],
      });
    if (url.endsWith("SKILL.md")) return new Response("Root instructions.");
    if (url.endsWith("run.sh")) return new Response("#!/bin/sh\nprintf fixture\n");
    return new Response("Asset fixture.");
  }) as typeof fetch;
  await downloadSkillTree({ owner: "fixture", repo: "skills" }, commit, "", target);
  expect(readFileSync(join(target, "assets", "example.txt"), "utf8")).toBe("Asset fixture.");
  expect(statSync(join(target, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
  expect(
    parseSkillSourceMeta({
      kind: "github",
      owner: "fixture",
      repo: "skills",
      ref: "main",
      dirInRepo: "",
      commit,
      installedAt: "2026-09-08",
    }),
  ).not.toBeNull();
});

test("rejects truncated or linked repository trees before publishing an incomplete bundle", async () => {
  const target = directory();
  globalThis.fetch = (async () =>
    Response.json({
      truncated: true,
      tree: [{ path: "demo/SKILL.md", type: "blob", sha: "blob" }],
    })) as typeof fetch;
  await expect(
    downloadSkillTree({ owner: "fixture", repo: "skills" }, commit, "demo", target),
  ).rejects.toThrow("完整目录树");
  expect(readdirSync(target)).toEqual([]);
  globalThis.fetch = (async () =>
    Response.json({
      tree: [{ path: "demo/SKILL.md", type: "blob", sha: "blob", mode: "120000" }],
    })) as typeof fetch;
  await expect(
    downloadSkillTree({ owner: "fixture", repo: "skills" }, commit, "demo", target),
  ).rejects.toThrow("符号链接");
  expect(readdirSync(target)).toEqual([]);
});

test("source updates preserve edits made while the remote version is downloading", async () => {
  const root = directory();
  const skill = join(root, "demo");
  mkdirSync(skill);
  const file = join(skill, "SKILL.md");
  writeFileSync(file, "Original local instructions.");
  const metadata = {
    kind: "github",
    owner: "fixture",
    repo: "skills",
    ref: "main",
    dirInRepo: "demo",
    commit,
    installedAt: "2026-09-08",
  };
  writeFileSync(join(skill, SKILL_META_FILE), JSON.stringify(metadata));
  await expect(
    updateSkillFromSource(file, {
      getRefCommit: async () => "b".repeat(40),
      downloadSkillTree: async (_info, _ref, _dir, destination) => {
        writeFileSync(file, "New unsent local work.");
        writeFileSync(join(destination, "SKILL.md"), "Remote replacement.");
      },
    }),
  ).rejects.toThrow("变化");
  expect(readFileSync(file, "utf8")).toBe("New unsent local work.");
  expect(JSON.parse(readFileSync(join(skill, SKILL_META_FILE), "utf8"))).toEqual(metadata);
});
