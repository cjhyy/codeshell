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
});
