import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFiles, searchProjectFiles } from "../../../packages/desktop/src/main/file-search-service";

const owned: string[] = [];
async function fixture(git = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-audit-file-search-"));
  owned.push(root);
  if (git) execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
  return root;
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("audit D01: Git quotes Unicode and special names, so live search returns nonexistent paths", async () => {
  const root = await fixture(true);
  await writeFile(join(root, "报告.md"), "owned unicode fixture\n");
  await writeFile(join(root, "ascii.md"), "owned ascii fixture\n");
  await writeFile(join(root, "line\nbreak.md"), "owned newline fixture\n");
  const all = await searchFiles(root, "");
  const chinese = await searchFiles(root, "报告");
  const ascii = await searchFiles(root, "ascii");
  const exists = await Promise.all(all.map(async (hit) => ({
    path: hit.path,
    exists: await access(join(root, hit.path)).then(() => true, () => false),
  })));
  console.log("D01", JSON.stringify({ all, chinese, ascii, exists }));
  expect(chinese).toEqual([]);
  expect(ascii.map((hit) => hit.path)).toEqual(["ascii.md"]);
  expect(all.some((hit) => hit.path.includes("\\346\\212\\245"))).toBe(true);
  expect(exists.filter((hit) => !hit.exists)).toHaveLength(2);
});

test("audit D01 control: non-Git Unicode filename uses actual path", async () => {
  const root = await fixture();
  await writeFile(join(root, "报告.md"), "owned unicode fixture\n");
  expect((await searchFiles(root, "报告")).map((hit) => hit.path)).toEqual(["报告.md"]);
});

test("audit D02: global top30 excludes active root before MentionPopover's root filter", async () => {
  const active = await fixture(true);
  const other = await fixture(true);
  await mkdir(join(active, "a-long-directory"));
  await writeFile(join(active, "a-long-directory", "needle-document.md"), "active fixture\n");
  await Promise.all(Array.from({ length: 30 }, (_, index) =>
    writeFile(join(other, `needle-${String(index).padStart(2, "0")}.md`), "other fixture\n"),
  ));
  const activeOnly = await searchFiles(active, "needle");
  const project = await searchProjectFiles([
    { id: "active", path: active },
    { id: "other", path: other },
  ], "needle");
  // The production MentionPopover applies exactly this filter after the service cap.
  const visible = project.filter((hit) => hit.rootId === "active");
  console.log("D02", JSON.stringify({ activeOnly, project, visible }));
  expect(activeOnly.map((hit) => hit.path)).toEqual(["a-long-directory/needle-document.md"]);
  expect(project).toHaveLength(30);
  expect(project.every((hit) => hit.rootId === "other")).toBe(true);
  expect(visible).toEqual([]);
});
