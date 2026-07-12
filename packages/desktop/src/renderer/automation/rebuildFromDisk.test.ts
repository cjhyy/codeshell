import { describe, it, expect } from "bun:test";
import { planDiskRebuild } from "./rebuildFromDisk";
import type { ProjectLike } from "./pathMatch";

// ProjectLike requires { id, name, path } — include `name`.
const repo = (id: string, path: string): ProjectLike => ({ id, name: id, path });

describe("planDiskRebuild", () => {
  it("matches an existing repo by cwd", () => {
    const projects: ProjectLike[] = [repo("r1", "/proj/a")];
    const out = planDiskRebuild(
      [{ id: "s1", engineSessionId: "s1", cwd: "/proj/a", title: "聊天", updatedAt: 100 }],
      projects,
      { caseInsensitive: false, createProjectForCwd: () => "SHOULD_NOT_CALL" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].projectId).toBe("r1");
    expect(out[0].summary).toMatchObject({ id: "s1", engineSessionId: "s1", title: "聊天" });
    expect(out[0].summary.source).toBeUndefined();
  });

  it("auto-creates a repo for an unmatched cwd", () => {
    let created = "";
    const out = planDiskRebuild(
      [{ id: "s2", engineSessionId: "s2", cwd: "/proj/new", title: "x", updatedAt: 1 }],
      [],
      {
        caseInsensitive: false,
        createProjectForCwd: (cwd) => {
          created = cwd;
          return "r-new";
        },
      },
    );
    expect(created).toBe("/proj/new");
    expect(out[0].projectId).toBe("r-new");
  });

  it("matches an existing root repo after resolving a git subdirectory cwd", () => {
    let created = false;
    const out = planDiskRebuild(
      [
        {
          id: "s-sub",
          engineSessionId: "s-sub",
          cwd: "/repo/root/packages/desktop",
          title: "x",
          updatedAt: 1,
        },
      ],
      [repo("root", "/repo/root")],
      {
        caseInsensitive: false,
        resolveCwd: (cwd) => (cwd === "/repo/root/packages/desktop" ? "/repo/root" : cwd),
        createProjectForCwd: () => {
          created = true;
          return "SHOULD_NOT_CREATE";
        },
      },
    );
    expect(created).toBe(false);
    expect(out[0].projectId).toBe("root");
  });

  it("skips an unmatched cwd when repo creation returns null", () => {
    const out = planDiskRebuild(
      [{ id: "s2", engineSessionId: "s2", cwd: "/proj/removed", title: "x", updatedAt: 1 }],
      [],
      { caseInsensitive: false, createProjectForCwd: () => null },
    );
    expect(out).toEqual([]);
  });

  it("routes a no-repo sandbox cwd to chat (projectId null), never creating a repo", () => {
    let called = false;
    const out = planDiskRebuild(
      [
        {
          id: "s3",
          engineSessionId: "s3",
          cwd: "/Users/admin/.code-shell/no-repo",
          title: "你好",
          updatedAt: 5,
        },
      ],
      [],
      {
        caseInsensitive: false,
        createProjectForCwd: () => {
          called = true;
          return "X";
        },
      },
    );
    expect(called).toBe(false); // must NOT create a "no-repo" project
    expect(out[0].projectId).toBeNull(); // null → NO_REPO_KEY (chat) bucket
    expect(out[0].summary).toMatchObject({ id: "s3", engineSessionId: "s3" });
  });

  it("marks automation-origin sessions with source:automation (⚙); desktop stays undefined", () => {
    const out = planDiskRebuild(
      [
        {
          id: "a",
          engineSessionId: "a",
          cwd: "/proj/a",
          title: "新闻",
          updatedAt: 2,
          origin: "automation",
        },
        {
          id: "d",
          engineSessionId: "d",
          cwd: "/proj/a",
          title: "聊天",
          updatedAt: 1,
          origin: "desktop",
        },
      ],
      [{ id: "r1", name: "a", path: "/proj/a" }],
      { caseInsensitive: false, createProjectForCwd: () => "X" },
    );
    const a = out.find((p) => p.summary.id === "a")!;
    const d = out.find((p) => p.summary.id === "d")!;
    expect(a.summary.source).toBe("automation");
    expect(d.summary.source).toBeUndefined();
  });
});
