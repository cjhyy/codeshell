import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePluginTreeDigest } from "../pluginTreeDigest.js";
import {
  collectNativeSnapshots,
  nativeRuntimeRoot,
  nativeSnapshotDir,
  prepareNativeSnapshot,
  removeNativeSnapshot,
  removeNativeSnapshots,
  touchNativeSnapshot,
} from "./snapshot.js";

describe("native plugin runtime snapshot", () => {
  let home: string;
  let previousHome: string | undefined;
  let installPath: string;
  let runtimeRoot: string;
  const moduleId = "plugin-demo-0123abcd";

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "native-snapshot-"));
    process.env.HOME = home;
    // Resolved while HOME is the temporary one. Cleanup uses this captured
    // path and never re-derives it, so it cannot point at the real home.
    runtimeRoot = nativeRuntimeRoot();
    expect(runtimeRoot.startsWith(home)).toBe(true);
    installPath = join(home, "installed");
    mkdirSync(join(installPath, "dist"), { recursive: true });
    writeFileSync(join(installPath, "dist", "index.js"), "export default 1;\n");
    writeFileSync(join(installPath, ".cs-meta.json"), "{}");
  });

  afterEach(() => {
    removeNativeSnapshot(runtimeRoot);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function digest(path = installPath): string {
    const tree = computePluginTreeDigest(path);
    if (!tree.ok) throw new Error(tree.reason);
    return tree.digest;
  }

  function prepare(afterCopy?: (copy: string) => void) {
    return prepareNativeSnapshot({ moduleId, installPath, ...(afterCopy ? { afterCopy } : {}) });
  }

  function prepared() {
    const snapshot = prepare();
    if (!snapshot.ok) throw new Error(snapshot.reason);
    return snapshot;
  }

  const temporaries = () =>
    readdirSync(join(runtimeRoot, moduleId)).filter((name) => name.startsWith(".tmp-"));

  test("copies the plugin's current files beside the install root and verifies the copy", () => {
    const snapshot = prepare();
    expect(snapshot).toEqual({
      ok: true,
      root: nativeSnapshotDir(moduleId, digest()),
      digest: digest(),
    });
    if (!snapshot.ok) return;
    expect(snapshot.root.startsWith(join(home, ".code-shell", "plugin-runtime"))).toBe(true);
    expect(readFileSync(join(snapshot.root, "dist", "index.js"), "utf8")).toBe(
      "export default 1;\n",
    );
    expect(digest(snapshot.root)).toBe(digest());
  });

  test("an edited tree gets a snapshot of its own; the earlier one is left as it was", () => {
    const first = prepared();
    writeFileSync(join(installPath, "dist", "index.js"), "export default 'edited locally';\n");
    const second = prepared();
    expect(second.digest).toBe(digest());
    expect(second.root).not.toBe(first.root);
    expect(readFileSync(join(second.root, "dist", "index.js"), "utf8")).toContain("edited");
    expect(readFileSync(join(first.root, "dist", "index.js"), "utf8")).toBe("export default 1;\n");
  });

  test("what runs is the checked copy: later edits to the install tree do not reach it", () => {
    const snapshot = prepared();
    writeFileSync(join(installPath, "dist", "index.js"), "export default 'edited';\n");
    expect(readFileSync(join(snapshot.root, "dist", "index.js"), "utf8")).toBe(
      "export default 1;\n",
    );
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "the snapshot is read-only, so a plugin cannot keep state next to its code",
    () => {
      const snapshot = prepared();
      expect(() => writeFileSync(join(snapshot.root, "dist", "cache.json"), "{}")).toThrow();
      expect(() => writeFileSync(join(snapshot.root, "dist", "index.js"), "x")).toThrow();
    },
  );

  test("an existing snapshot is reused only while it still verifies", () => {
    const first = prepared();
    expect(prepare()).toEqual(first);

    // Tamper with the snapshot itself: it is rebuilt from the install tree.
    chmodSync(first.root, 0o700);
    removeNativeSnapshot(join(first.root, "dist"));
    expect(existsSync(join(first.root, "dist"))).toBe(false);
    expect(prepare()).toEqual(first);
    expect(readFileSync(join(first.root, "dist", "index.js"), "utf8")).toBe("export default 1;\n");
  });

  test("a copy that does not match what was hashed is taken again once, then refused", () => {
    let copies = 0;
    // The first copy comes out different, as if a file changed mid-copy.
    const once = prepare((copy) => {
      copies += 1;
      if (copies === 1) writeFileSync(join(copy, "dist", "index.js"), "half written");
    });
    expect(once).toEqual({
      ok: true,
      root: nativeSnapshotDir(moduleId, digest()),
      digest: digest(),
    });
    expect(copies).toBe(2);

    removeNativeSnapshots(moduleId);
    const always = prepare((copy) => writeFileSync(join(copy, "dist", "index.js"), "moving"));
    expect(always.ok).toBe(false);
    expect(always.ok ? "" : always.reason).toContain("kept changing");
    expect(temporaries()).toEqual([]);
  });

  test("leaves no temporary directory behind", () => {
    prepare();
    writeFileSync(join(installPath, "dist", "index.js"), "export default 2;\n");
    prepare();
    expect(temporaries()).toEqual([]);
  });

  test("a tree that cannot be read is refused without leaving anything behind", () => {
    rmSync(installPath, { recursive: true, force: true });
    const snapshot = prepare();
    expect(snapshot.ok).toBe(false);
    expect(existsSync(join(runtimeRoot, moduleId))).toBe(false);
  });

  test("uninstall removes every snapshot of the module", () => {
    prepared();
    removeNativeSnapshots(moduleId);
    expect(existsSync(join(runtimeRoot, moduleId))).toBe(false);
  });

  test("collection keeps referenced and recent snapshots and removes old unreferenced ones", () => {
    const current = prepared();
    writeFileSync(join(installPath, "dist", "index.js"), "export default 2;\n");
    const older = prepared();

    // Nothing is old enough yet.
    expect(collectNativeSnapshots(new Set([current.root]))).toEqual([]);

    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(older.root, longAgo, longAgo);
    utimesSync(current.root, longAgo, longAgo);
    expect(collectNativeSnapshots(new Set([current.root]))).toEqual([older.root]);
    expect(existsSync(older.root)).toBe(false);
    expect(existsSync(current.root)).toBe(true);
  });

  test("a snapshot touched when a process starts counts as recent", () => {
    const snapshot = prepared();
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(snapshot.root, longAgo, longAgo);

    touchNativeSnapshot(snapshot.root);
    expect(Date.now() - statSync(snapshot.root).mtimeMs).toBeLessThan(60_000);
    expect(collectNativeSnapshots(new Set())).toEqual([]);
    expect(existsSync(snapshot.root)).toBe(true);
  });
});
