import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFiles, searchProjectFiles } from "./file-search-service.js";

describe("searchFiles", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "file-search-"));
    mkdirSync(join(cwd, "src", "components"), { recursive: true });
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, "src", "components", "Button.tsx"), "export {}\n");
    writeFileSync(join(cwd, "docs", "guide.md"), "# guide\n");
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = {}\n");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("returns file and directory hits with kind", async () => {
    const hits = await searchFiles(cwd, "src");
    expect(hits.some((hit) => hit.path === "src" && hit.kind === "dir")).toBe(true);
    expect(hits.some((hit) => hit.path === "src/components" && hit.kind === "dir")).toBe(true);
    expect(
      hits.some((hit) => hit.path === "src/components/Button.tsx" && hit.kind === "file"),
    ).toBe(true);
  });

  test("ignored directories do not appear", async () => {
    const hits = await searchFiles(cwd, "node");
    expect(hits.some((hit) => hit.path.startsWith("node_modules"))).toBe(false);
  });
});

describe("searchProjectFiles", () => {
  test("merges roots serially, preserves rootId, deduplicates, reranks, and caps results", async () => {
    const calls: string[] = [];
    const hits = await searchProjectFiles(
      [
        { id: "root-a", path: "/a" },
        { id: "root-b", path: "/b" },
      ],
      "button",
      async (cwd) => {
        calls.push(cwd);
        if (cwd === "/a") {
          return [
            { path: "src/Button.tsx", name: "Button.tsx", kind: "file" },
            { path: "src/Button.tsx", name: "Button.tsx", kind: "file" },
          ];
        }
        return Array.from({ length: 35 }, (_, index) => ({
          path: index === 0 ? "Button.md" : `docs/button-${index}.md`,
          name: index === 0 ? "Button.md" : `button-${index}.md`,
          kind: "file" as const,
        }));
      },
    );

    expect(calls).toEqual(["/a", "/b"]);
    expect(hits).toHaveLength(30);
    expect(hits[0]).toMatchObject({ rootId: "root-b", path: "Button.md" });
    expect(
      hits.filter((hit) => hit.rootId === "root-a" && hit.path === "src/Button.tsx"),
    ).toHaveLength(1);
    expect(hits.some((hit) => hit.rootId === "root-b")).toBe(true);
  });
});
