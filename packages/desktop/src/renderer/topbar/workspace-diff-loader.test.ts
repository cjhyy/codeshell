import { describe, expect, test } from "bun:test";
import type { SessionWorkspaceWorktreeInfo } from "../../preload/types";
import { WorkspaceDiffLoader } from "./workspace-diff-loader";

type Diff = NonNullable<SessionWorkspaceWorktreeInfo["diff"]>;

function row(path: string, head = "head-a"): SessionWorkspaceWorktreeInfo {
  return { path, head, branch: "main" };
}

function diff(changedFiles: number): Diff {
  return { changedFiles, aheadCommits: 0, hasUncommittedChanges: changedFiles > 0 };
}

function fixture() {
  let time = 0;
  let changes = 0;
  const requests: {
    path: string;
    resolve: (value: Diff) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const loader = new WorkspaceDiffLoader(
    (path) =>
      new Promise<Diff>((resolve, reject) => {
        requests.push({ path, resolve, reject });
      }),
    () => {
      changes += 1;
    },
    () => time,
  );
  return {
    loader,
    requests,
    changes: () => changes,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("WorkspaceDiffLoader", () => {
  test("loads only visible rows in an open menu, with at most two requests", async () => {
    const { loader, requests } = fixture();
    const rows = Array.from({ length: 100 }, (_, index) => row(`/tree-${index}`));
    loader.setRows(rows);
    loader.setVisible(rows[0].path, true);
    loader.setVisible(rows[1].path, true);
    loader.setVisible(rows[2].path, true);
    expect(requests).toHaveLength(0);

    loader.setOpen(true);
    expect(requests.map((request) => request.path)).toEqual(["/tree-0", "/tree-1"]);
    expect(loader.getState(rows[2]).status).toBe("idle");
    requests[0].resolve(diff(1));
    await flush();
    expect(requests.map((request) => request.path)).toEqual(["/tree-0", "/tree-1", "/tree-2"]);
    requests[1].resolve(diff(2));
    requests[2].resolve(diff(3));
    await flush();
    expect(requests).toHaveLength(3);
    expect(loader.getState(rows[99]).status).toBe("idle");
  });

  test("remembers visibility registered before the rows arrive", () => {
    const { loader, requests } = fixture();
    loader.setVisible("/tree", true);
    loader.setOpen(true);
    loader.setRows([row("/tree")]);
    expect(requests.map((request) => request.path)).toEqual(["/tree"]);
  });

  test("closing drops pending work while active results populate the cache", async () => {
    const { loader, requests } = fixture();
    const rows = [row("/a"), row("/b"), row("/c")];
    loader.setRows(rows);
    rows.forEach((item) => loader.setVisible(item.path, true));
    loader.setOpen(true);
    loader.setOpen(false);
    requests[0].resolve(diff(1));
    requests[1].resolve(diff(2));
    await flush();
    expect(requests).toHaveLength(2);
    expect(loader.getState(rows[0])).toEqual({ diff: diff(1), status: "ready" });
    loader.setOpen(true);
    expect(requests.map((request) => request.path)).toEqual(["/a", "/b", "/c"]);
  });

  test("scrolling a pending row away prevents its load after a slot is freed", async () => {
    const { loader, requests } = fixture();
    const rows = [row("/a"), row("/b"), row("/c"), row("/d")];
    loader.setRows(rows);
    rows.forEach((item) => loader.setVisible(item.path, true));
    loader.setOpen(true);
    loader.setVisible("/c", false);
    requests[0].resolve(diff(1));
    await flush();
    expect(requests.map((request) => request.path)).toEqual(["/a", "/b", "/d"]);
    requests[1].resolve(diff(2));
    requests[2].resolve(diff(4));
    await flush();
    expect(loader.getState(rows[2]).status).toBe("idle");
    loader.setVisible("/c", true);
    expect(requests[3].path).toBe("/c");
  });

  test("reopening uses a fresh cache and refreshes expired data without clearing it", async () => {
    const { loader, requests, advance } = fixture();
    const tree = row("/tree");
    loader.setRows([tree]);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    requests[0].resolve(diff(3));
    await flush();
    loader.setOpen(false);
    advance(29_999);
    loader.setOpen(true);
    expect(requests).toHaveLength(1);
    loader.setOpen(false);
    advance(1);
    loader.setOpen(true);
    expect(requests).toHaveLength(2);
    expect(loader.getState(tree)).toEqual({ diff: diff(3), status: "checking" });
    requests[1].resolve(diff(5));
    await flush();
    expect(loader.getState(tree)).toEqual({ diff: diff(5), status: "ready" });
  });

  test("failures end checking and preserve prior data through the retry cooldown", async () => {
    const { loader, requests, advance } = fixture();
    const tree = row("/tree");
    loader.setRows([tree]);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    requests[0].resolve(diff(2));
    await flush();
    loader.invalidate();
    requests[1].reject(new Error("unavailable"));
    await flush();
    expect(loader.getState(tree)).toEqual({ diff: diff(2), status: "error" });
    loader.setRows([tree]);
    loader.setVisible(tree.path, true);
    loader.setOpen(false);
    advance(29_999);
    loader.setOpen(true);
    expect(requests).toHaveLength(2);
    loader.setOpen(false);
    advance(1);
    loader.setOpen(true);
    expect(requests).toHaveLength(3);
  });

  test("synchronous load errors become terminal failures rather than retry loops", async () => {
    let calls = 0;
    const tree = row("/tree");
    const loader = new WorkspaceDiffLoader(
      () => {
        calls += 1;
        throw new Error("bridge unavailable");
      },
      () => {},
    );
    loader.setRows([tree]);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    await flush();
    expect(loader.getState(tree).status).toBe("error");
    loader.setOpen(true);
    expect(calls).toBe(1);
  });

  test("HEAD changes reject old results and serialize replacement checks for that path", async () => {
    const { loader, requests } = fixture();
    const oldHead = row("/tree");
    const newHead = row("/tree", "head-b");
    loader.setRows([oldHead]);
    loader.setVisible(oldHead.path, true);
    loader.setOpen(true);
    loader.setRows([newHead]);
    loader.setOpen(true);
    loader.setVisible(newHead.path, true);
    expect(requests).toHaveLength(1);
    expect(loader.getState(newHead).diff).toBeUndefined();
    requests[0].resolve(diff(99));
    await flush();
    expect(requests).toHaveLength(2);
    expect(loader.getState(newHead)).toEqual({ diff: undefined, status: "checking" });
    requests[1].resolve(diff(1));
    await flush();
    expect(loader.getState(newHead)).toEqual({ diff: diff(1), status: "ready" });
  });

  test("invalidation during a check schedules one replacement and rejects the old result", async () => {
    const { loader, requests } = fixture();
    const tree = row("/tree");
    loader.setRows([tree]);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    requests[0].resolve(diff(2));
    await flush();
    loader.invalidate();
    loader.invalidate();
    loader.setRows([tree]);
    expect(requests).toHaveLength(2);
    requests[1].resolve(diff(99));
    await flush();
    expect(requests).toHaveLength(3);
    expect(loader.getState(tree)).toEqual({ diff: diff(2), status: "checking" });
    requests[2].resolve(diff(4));
    await flush();
    expect(loader.getState(tree)).toEqual({ diff: diff(4), status: "ready" });
    expect(requests).toHaveLength(3);
  });

  test("a changed main HEAD invalidates other summaries that depend on its comparison base", async () => {
    const { loader, requests } = fixture();
    const main = { ...row("/main"), isMain: true };
    const tree = row("/tree");
    loader.setRows([main, tree]);
    loader.setVisible(main.path, true);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    requests[0].resolve(diff(0));
    requests[1].resolve(diff(2));
    await flush();
    loader.setRows([{ ...main, head: "new-main-head" }, tree]);
    expect(requests.map((request) => request.path)).toEqual(["/main", "/tree", "/main", "/tree"]);
    expect(loader.getState(tree)).toEqual({ diff: diff(2), status: "checking" });
    requests[2].resolve(diff(0));
    requests[3].resolve(diff(1));
    await flush();
    expect(loader.getState(tree)).toEqual({ diff: diff(1), status: "ready" });
  });

  test("branch changes invalidate their own cache and main branch changes refresh the base", async () => {
    const { loader, requests } = fixture();
    const main = { ...row("/main"), isMain: true };
    const tree = row("/tree");
    loader.setRows([main, tree]);
    loader.setVisible(main.path, true);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    requests[0].resolve(diff(0));
    requests[1].resolve(diff(2));
    await flush();
    const renamed = { ...tree, branch: "feature" };
    loader.setRows([main, renamed]);
    expect(requests).toHaveLength(3);
    expect(requests[2].path).toBe(tree.path);
    requests[2].resolve(diff(3));
    await flush();
    loader.setRows([{ ...main, branch: "master" }, renamed]);
    expect(requests).toHaveLength(5);
    expect(loader.getState(renamed)).toEqual({ diff: diff(3), status: "checking" });
  });

  test("removed rows lose cached data and cannot accept an earlier request after reappearing", async () => {
    const { loader, requests } = fixture();
    const tree = row("/tree");
    loader.setRows([tree]);
    loader.setVisible(tree.path, true);
    loader.setOpen(true);
    loader.setRows([]);
    loader.setRows([tree]);
    requests[0].resolve(diff(99));
    await flush();
    expect(requests).toHaveLength(1);
    expect(loader.getState(tree).status).toBe("idle");
    loader.setVisible(tree.path, true);
    expect(requests).toHaveLength(2);
    requests[1].resolve(diff(1));
    await flush();
    loader.setRows([]);
    loader.setRows([tree]);
    expect(loader.getState(tree).diff).toBeUndefined();
  });

  test("each authority instance owns its cache and dispose prevents further work or callbacks", async () => {
    const first = fixture();
    const second = fixture();
    const tree = row("/tree");
    for (const { loader } of [first, second]) {
      loader.setRows([tree]);
      loader.setVisible(tree.path, true);
      loader.setOpen(true);
    }
    first.requests[0].resolve(diff(1));
    await flush();
    expect(second.loader.getState(tree).diff).toBeUndefined();
    expect(second.requests).toHaveLength(1);
    second.loader.dispose();
    const previousChanges = second.changes();
    second.requests[0].resolve(diff(99));
    await flush();
    second.loader.invalidate();
    second.loader.setRows([tree]);
    second.loader.setOpen(true);
    second.loader.setVisible(tree.path, true);
    expect(second.changes()).toBe(previousChanges);
    expect(second.requests).toHaveLength(1);
  });
});
