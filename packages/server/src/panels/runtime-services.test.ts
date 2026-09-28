import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelRuntimeServices, type PanelRuntimeScope } from "./runtime-services.js";
import { panelAppStoragePath } from "./storage-store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codeshell-web-panel-runtime-"));
  directories.push(root);
  const cwd = join(root, "项目 %20");
  await mkdir(cwd);
  const dataDir = join(root, "data");
  const runtime = new PanelRuntimeServices({ dataDir });
  const scope: PanelRuntimeScope = {
    appId: "test-panel",
    cwd,
    projectPath: cwd,
    permissions: [
      "context.workspace",
      "workspace.info",
      "workspace.read",
      "workspace.write",
      "storage",
    ],
    isAuthorized: async () => true,
  };
  return { root, cwd, dataDir, runtime, scope };
}

describe("PanelRuntimeServices", () => {
  test("round-trips Desktop workspace metadata and SHA revision writes", async () => {
    const { cwd, runtime, scope } = await fixture();
    const created = (await runtime.call(scope, "workspace.writeText", {
      path: "设计/页面.json",
      content: '{"value":1}',
      expectedModifiedAt: null,
    })) as any;
    expect(created).toMatchObject({ path: "设计/页面.json", size: 11 });
    expect(created.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    const opened = (await runtime.call(scope, "workspace.readText", {
      path: "设计/页面.json",
    })) as any;
    expect(opened).toEqual({ ...created, content: '{"value":1}' });
    const next = (await runtime.call(scope, "workspace.writeText", {
      path: created.path,
      content: "更新",
      expectedRevision: opened.revision,
    })) as any;
    expect(next.size).toBe(6);
    expect(await readFile(join(cwd, created.path), "utf8")).toBe("更新");
    await expect(
      runtime.call(scope, "workspace.writeText", {
        path: created.path,
        content: "旧值",
        expectedRevision: opened.revision,
      }),
    ).rejects.toThrow("changed");
    expect(await runtime.call(scope, "workspace.info")).toMatchObject({
      name: "项目 %20",
      root: cwd,
      trusted: true,
      gitBranch: null,
    });
  });

  test("requires a current owner and declared permissions for every operation", async () => {
    const { runtime, scope } = await fixture();
    await expect(
      runtime.call({ ...scope, permissions: [] }, "storage.get", { key: "draft" }),
    ).rejects.toThrow("permission denied");
    await expect(
      runtime.call({ ...scope, permissions: ["workspace.read"] }, "workspace.readText", {
        path: "draft.json",
      }),
    ).rejects.toThrow("context.workspace");
    await expect(
      runtime.call({ ...scope, isAuthorized: async () => false }, "workspace.info"),
    ).rejects.toThrow("no longer authorized");
    await expect(runtime.call(scope, "process.spawn", {})).rejects.toThrow(
      "unsupported by this host",
    );
  });

  test("isolates JSON storage by app and project while preserving Desktop's path hash", async () => {
    const { runtime, scope, dataDir, cwd } = await fixture();
    const expected = createHash("sha256")
      .update(`codeshell-panel-app-storage-v2\0test-panel\0${cwd}`)
      .digest("hex");
    expect(panelAppStoragePath(dataDir, scope.appId, cwd)).toBe(
      join(dataDir, "panel-app-storage", `${expected}.json`),
    );
    expect(await runtime.call(scope, "storage.get", { key: "draft" })).toBeNull();
    expect(
      await runtime.call(scope, "storage.set", { key: "__proto__", value: { saved: true } }),
    ).toBe(true);
    expect(await runtime.call(scope, "storage.get", { key: "__proto__" })).toEqual({ saved: true });
    expect(
      await runtime.call({ ...scope, appId: "other-panel" }, "storage.get", { key: "__proto__" }),
    ).toBeNull();
    expect(
      await runtime.call({ ...scope, projectPath: `${cwd}-other` }, "storage.get", {
        key: "__proto__",
      }),
    ).toBeNull();
    expect(await runtime.call(scope, "storage.delete", { key: "__proto__" })).toBe(true);
    expect(await runtime.call(scope, "storage.delete", { key: "__proto__" })).toBe(false);
  });

  test("concurrent Web instances keep all distinct storage keys", async () => {
    const { runtime, scope, dataDir } = await fixture();
    const another = new PanelRuntimeServices({ dataDir });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? runtime : another).call(scope, "storage.set", { key: `item-${i}`, value: i }),
      ),
    );
    expect(
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          runtime.call(scope, "storage.get", { key: `item-${i}` }),
        ),
      ),
    ).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test("snapshot writes reject a stale device and survive a new Host instance", async () => {
    const { runtime, scope, dataDir } = await fixture();
    const another = new PanelRuntimeServices({ dataDir });
    const missing = await runtime.call(scope, "storage.getSnapshot", { key: "draft" });
    expect(missing).toEqual({ exists: false, value: null, revision: null });
    const writes = (await Promise.all(
      [runtime, another].map((service, index) =>
        service.call(scope, "storage.compareAndSet", {
          key: "draft",
          expectedRevision: null,
          value: { device: index },
        }),
      ),
    )) as any[];
    expect(writes.filter((value) => value.updated)).toHaveLength(1);
    const winner = writes.find((value) => value.updated).snapshot;
    expect(writes.find((value) => !value.updated).snapshot).toEqual(winner);
    const restarted = new PanelRuntimeServices({ dataDir });
    expect(await restarted.call(scope, "storage.getSnapshot", { key: "draft" })).toEqual(winner);
    expect(await restarted.call(scope, "storage.get", { key: "draft" })).toEqual(winner.value);
    // Old clients participate in conflict detection without changing their storage format.
    await another.call(scope, "storage.set", { key: "draft", value: "legacy update" });
    expect(
      await runtime.call(scope, "storage.compareAndSet", {
        key: "draft",
        expectedRevision: winner.revision,
        value: "stale edit",
      }),
    ).toMatchObject({ updated: false, snapshot: { value: "legacy update" } });
  });

  test("versioned storage distinguishes null from absent and supports conditional removal", async () => {
    const { runtime, scope } = await fixture();
    const saved = (await runtime.call(scope, "storage.compareAndSet", {
      key: "__proto__",
      expectedRevision: null,
      value: null,
    })) as any;
    expect(saved).toMatchObject({ updated: true, snapshot: { exists: true, value: null } });
    expect(saved.snapshot.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Another key can change without causing a conflict in this document.
    await runtime.call(scope, "storage.set", { key: "other", value: 1 });
    expect(
      await runtime.call(scope, "storage.compareAndSet", {
        key: "__proto__",
        expectedRevision: null,
        remove: true,
      }),
    ).toEqual({ updated: false, snapshot: saved.snapshot });
    expect(
      await runtime.call(scope, "storage.compareAndSet", {
        key: "__proto__",
        expectedRevision: saved.snapshot.revision,
        remove: true,
      }),
    ).toEqual({ updated: true, snapshot: { exists: false, value: null, revision: null } });
    expect(await runtime.call(scope, "storage.get", { key: "other" })).toBe(1);
  });

  test("versioned storage validates input and permissions without a blind fallback", async () => {
    const { runtime, scope } = await fixture();
    for (const params of [
      { key: "a", value: 1 },
      { key: "a", value: 1, expectedRevision: "anything" },
      { key: "a", expectedRevision: null },
      { key: "a", value: 1, expectedRevision: null, remove: true },
      { key: "a", value: 1, expectedRevision: null, remove: "true" },
    ])
      await expect(runtime.call(scope, "storage.compareAndSet", params)).rejects.toThrow();
    for (const method of ["storage.getSnapshot", "storage.compareAndSet"])
      await expect(
        runtime.call({ ...scope, permissions: [] }, method, {
          key: "a",
          expectedRevision: null,
          value: 1,
        }),
      ).rejects.toThrow("permission denied");
    await expect(
      runtime.call(scope, "storage.compareAndSet", {
        key: "a",
        expectedRevision: null,
        value: "x".repeat(256 * 1024),
      }),
    ).rejects.toThrow("quota");
    expect(await runtime.call(scope, "storage.getSnapshot", { key: "a" })).toEqual({
      exists: false,
      value: null,
      revision: null,
    });
  });

  test("a revoked versioned write does not publish staged bytes", async () => {
    const { runtime, scope } = await fixture();
    let checks = 0;
    await expect(
      runtime.call({ ...scope, isAuthorized: async () => ++checks < 3 }, "storage.compareAndSet", {
        key: "a",
        expectedRevision: null,
        value: "revoked",
      }),
    ).rejects.toThrow("no longer authorized");
    expect(await runtime.call(scope, "storage.get", { key: "a" })).toBeNull();
  });

  test("bounded storage rejects oversized data and linked targets", async () => {
    const { root, runtime, scope, dataDir } = await fixture();
    await expect(
      runtime.call(scope, "storage.set", { key: "large", value: "x".repeat(256 * 1024) }),
    ).rejects.toThrow("quota");
    const outside = join(root, "outside.json");
    await writeFile(outside, '{"keep":true}');
    const file = panelAppStoragePath(dataDir, scope.appId, scope.projectPath);
    await rm(file);
    await symlink(outside, file);
    await expect(runtime.call(scope, "storage.get", { key: "keep" })).rejects.toThrow(
      "regular file",
    );
    await expect(runtime.call(scope, "storage.set", { key: "keep", value: false })).rejects.toThrow(
      "regular file",
    );
    expect(await readFile(outside, "utf8")).toBe('{"keep":true}');
  });

  test("does not publish a storage write when the owner is revoked during staging", async () => {
    const { runtime, scope } = await fixture();
    await runtime.call(scope, "storage.set", { key: "draft", value: "original" });
    let checks = 0;
    await expect(
      runtime.call({ ...scope, isAuthorized: async () => ++checks < 3 }, "storage.set", {
        key: "draft",
        value: "revoked",
      }),
    ).rejects.toThrow("no longer authorized");
    expect(await runtime.call(scope, "storage.get", { key: "draft" })).toBe("original");
  });

  test("rejects a storage namespace replaced by a link during owner validation", async () => {
    const { root, dataDir, runtime, scope } = await fixture();
    await runtime.call(scope, "storage.set", { key: "draft", value: "original" });
    const outside = join(root, "outside-storage");
    await mkdir(outside);
    const storage = panelAppStoragePath(dataDir, scope.appId, scope.projectPath);
    const target = join(outside, storage.split("/").at(-1)!);
    await writeFile(target, '{"draft":"outside"}');
    let checks = 0;
    const changingScope = {
      ...scope,
      isAuthorized: async () => {
        if (++checks === 3) {
          await rename(join(dataDir, "panel-app-storage"), join(dataDir, "previous-storage"));
          await symlink(outside, join(dataDir, "panel-app-storage"));
        }
        return true;
      },
    };
    await expect(
      runtime.call(changingScope, "storage.set", { key: "draft", value: "changed" }),
    ).rejects.toThrow("real directory");
    expect(await readFile(target, "utf8")).toBe('{"draft":"outside"}');
  });

  test("does not publish a workspace write when authorization expires before commit", async () => {
    const { cwd, runtime, scope } = await fixture();
    await writeFile(join(cwd, "draft.txt"), "original");
    const original = (await runtime.call(scope, "workspace.readText", {
      path: "draft.txt",
    })) as any;
    let checks = 0;
    await expect(
      runtime.call({ ...scope, isAuthorized: async () => ++checks < 3 }, "workspace.writeText", {
        path: "draft.txt",
        content: "revoked",
        expectedRevision: original.revision,
      }),
    ).rejects.toThrow("no longer authorized");
    expect(await readFile(join(cwd, "draft.txt"), "utf8")).toBe("original");
  });

  test("rechecks file changes made while owner validation is pending", async () => {
    const { cwd, runtime, scope } = await fixture();
    await writeFile(join(cwd, "draft.txt"), "original");
    const original = (await runtime.call(scope, "workspace.readText", {
      path: "draft.txt",
    })) as any;
    let checks = 0;
    const editingScope = {
      ...scope,
      isAuthorized: async () => {
        if (++checks === 3) await writeFile(join(cwd, "draft.txt"), "external edit");
        return true;
      },
    };
    await expect(
      runtime.call(editingScope, "workspace.writeText", {
        path: "draft.txt",
        content: "stale panel",
        expectedRevision: original.revision,
      }),
    ).rejects.toThrow("changed");
    expect(await readFile(join(cwd, "draft.txt"), "utf8")).toBe("external edit");
  });

  test("rejects traversal, hidden settings, device paths, links, and binary text", async () => {
    const { root, cwd, runtime, scope } = await fixture();
    await writeFile(join(root, "outside.json"), '"secret"');
    await symlink(join(root, "outside.json"), join(cwd, "linked.json"));
    await symlink(root, join(cwd, "linked-directory"));
    for (const path of [
      "../outside.json",
      "/etc/passwd",
      ".code-shell/settings.json",
      ".env.json",
      "node_modules/a.json",
      "CON.txt",
      "a\\b.json",
      "nested/../outside.json",
      "linked.json",
      "linked-directory/outside.json",
    ]) {
      await expect(runtime.call(scope, "workspace.readText", { path })).rejects.toThrow();
      await expect(
        runtime.call(scope, "workspace.writeText", {
          path,
          content: "changed",
          expectedModifiedAt: null,
        }),
      ).rejects.toThrow();
    }
    await writeFile(join(cwd, "bytes.txt"), Buffer.from([0xff, 0xfe]));
    await expect(
      runtime.call(scope, "workspace.readText", { path: "bytes.txt" }),
    ).rejects.toThrow();
    await writeFile(join(cwd, "large.txt"), "x".repeat(480 * 1024 + 1));
    await expect(runtime.call(scope, "workspace.readText", { path: "large.txt" })).rejects.toThrow(
      "too large",
    );
    expect(await readFile(join(root, "outside.json"), "utf8")).toBe('"secret"');
  });

  test("lists only supported ordinary files and returns the existing missing-directory shape", async () => {
    const { root, cwd, runtime, scope } = await fixture();
    await mkdir(join(cwd, "docs"));
    await Promise.all([
      writeFile(join(cwd, "b.txt"), "ok"),
      writeFile(join(cwd, "a.json"), "{}"),
      writeFile(join(cwd, ".env.json"), "secret"),
      writeFile(join(cwd, "video.mp4"), "bytes"),
      symlink(root, join(cwd, "outside")),
    ]);
    expect(await runtime.call(scope, "workspace.list", { path: "missing" })).toEqual({
      path: "missing",
      entries: [],
      truncated: false,
    });
    const result = (await runtime.call(scope, "workspace.list")) as any;
    expect(result.path).toBe(".");
    expect(result.entries.map((entry: any) => entry.name)).toEqual(["a.json", "b.txt", "docs"]);
    expect(result.truncated).toBe(false);
  });

  test("rejects changed roots and refuses blind or racing writes", async () => {
    const { cwd, runtime, scope, dataDir } = await fixture();
    await expect(
      runtime.call(scope, "workspace.writeText", { path: "draft.txt", content: "blind" }),
    ).rejects.toThrow("prevent blind overwrites");
    const results = await Promise.allSettled(
      [runtime, new PanelRuntimeServices({ dataDir })].map((service) =>
        service.call(scope, "workspace.writeText", {
          path: "draft.txt",
          content: "once",
          expectedModifiedAt: null,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await rename(cwd, `${cwd}-previous`);
    await mkdir(cwd);
    await writeFile(join(cwd, "draft.txt"), "replaced");
    await expect(runtime.call(scope, "workspace.readText", { path: "draft.txt" })).rejects.toThrow(
      "root changed",
    );
    await expect(
      runtime.call(scope, "workspace.writeText", {
        path: "draft.txt",
        content: "overwrite",
        expectedModifiedAt: null,
      }),
    ).rejects.toThrow("root changed");
  });
});
