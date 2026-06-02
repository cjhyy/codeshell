import { describe, it, expect } from "bun:test";
import { planDiskRebuild } from "./rebuildFromDisk";
import type { RepoLike } from "./pathMatch";

// RepoLike requires { id, name, path } — include `name`.
const repo = (id: string, path: string): RepoLike => ({ id, name: id, path });

describe("planDiskRebuild", () => {
  it("matches an existing repo by cwd", () => {
    const repos: RepoLike[] = [repo("r1", "/proj/a")];
    const out = planDiskRebuild(
      [{ id: "s1", engineSessionId: "s1", cwd: "/proj/a", title: "聊天", updatedAt: 100 }],
      repos,
      { caseInsensitive: false, createRepoForCwd: () => "SHOULD_NOT_CALL" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].repoId).toBe("r1");
    expect(out[0].summary).toMatchObject({ id: "s1", engineSessionId: "s1", title: "聊天" });
    expect(out[0].summary.source).toBeUndefined();
  });

  it("auto-creates a repo for an unmatched cwd", () => {
    let created = "";
    const out = planDiskRebuild(
      [{ id: "s2", engineSessionId: "s2", cwd: "/proj/new", title: "x", updatedAt: 1 }],
      [],
      { caseInsensitive: false, createRepoForCwd: (cwd) => { created = cwd; return "r-new"; } },
    );
    expect(created).toBe("/proj/new");
    expect(out[0].repoId).toBe("r-new");
  });

  it("routes a no-repo sandbox cwd to chat (repoId null), never creating a repo", () => {
    let called = false;
    const out = planDiskRebuild(
      [{ id: "s3", engineSessionId: "s3", cwd: "/Users/admin/.code-shell/no-repo", title: "你好", updatedAt: 5 }],
      [],
      { caseInsensitive: false, createRepoForCwd: () => { called = true; return "X"; } },
    );
    expect(called).toBe(false); // must NOT create a "no-repo" project
    expect(out[0].repoId).toBeNull(); // null → NO_REPO_KEY (chat) bucket
    expect(out[0].summary).toMatchObject({ id: "s3", engineSessionId: "s3" });
  });

  it("marks automation-origin sessions with source:automation (⚙); desktop stays undefined", () => {
    const out = planDiskRebuild(
      [
        { id: "a", engineSessionId: "a", cwd: "/proj/a", title: "新闻", updatedAt: 2, origin: "automation" },
        { id: "d", engineSessionId: "d", cwd: "/proj/a", title: "聊天", updatedAt: 1, origin: "desktop" },
      ],
      [{ id: "r1", name: "a", path: "/proj/a" }],
      { caseInsensitive: false, createRepoForCwd: () => "X" },
    );
    const a = out.find((p) => p.summary.id === "a")!;
    const d = out.find((p) => p.summary.id === "d")!;
    expect(a.summary.source).toBe("automation");
    expect(d.summary.source).toBeUndefined();
  });
});
