import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

  function prepare(contentDigest = digest()) {
    return prepareNativeSnapshot({ moduleId, installPath, contentDigest });
  }

  test("copies the approved tree beside the install root and verifies the copy", () => {
    const snapshot = prepare();
    expect(snapshot).toEqual({ ok: true, root: nativeSnapshotDir(moduleId, digest()) });
    if (!snapshot.ok) return;
    expect(snapshot.root.startsWith(join(home, ".code-shell", "plugin-runtime"))).toBe(true);
    expect(readFileSync(join(snapshot.root, "dist", "index.js"), "utf8")).toBe(
      "export default 1;\n",
    );
    expect(digest(snapshot.root)).toBe(digest());
  });

  test("refuses to snapshot a tree that is not the approved content", () => {
    const approved = digest();
    writeFileSync(join(installPath, "dist", "index.js"), "export default 2;\n");
    const snapshot = prepare(approved);
    expect(snapshot.ok).toBe(false);
    expect(existsSync(nativeSnapshotDir(moduleId, approved))).toBe(false);
    expect(snapshot.ok ? "" : snapshot.reason).toContain("no longer matches");
  });

  test("what runs is the checked copy: later edits to the install tree do not reach it", () => {
    const snapshot = prepare();
    if (!snapshot.ok) throw new Error(snapshot.reason);
    writeFileSync(join(installPath, "dist", "index.js"), "export default 'edited';\n");
    expect(readFileSync(join(snapshot.root, "dist", "index.js"), "utf8")).toBe(
      "export default 1;\n",
    );
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "the snapshot is read-only, so a plugin cannot keep state next to its code",
    () => {
      const snapshot = prepare();
      if (!snapshot.ok) throw new Error(snapshot.reason);
      expect(() => writeFileSync(join(snapshot.root, "dist", "cache.json"), "{}")).toThrow();
      expect(() => writeFileSync(join(snapshot.root, "dist", "index.js"), "x")).toThrow();
    },
  );

  test("an existing snapshot is reused only while it still verifies", () => {
    const first = prepare();
    if (!first.ok) throw new Error(first.reason);
    expect(prepare()).toEqual(first);

    // Tamper with the snapshot itself: it is rebuilt from the approved tree.
    chmodSync(first.root, 0o700);
    removeNativeSnapshot(join(first.root, "dist"));
    expect(existsSync(join(first.root, "dist"))).toBe(false);
    expect(prepare()).toEqual(first);
    expect(readFileSync(join(first.root, "dist", "index.js"), "utf8")).toBe("export default 1;\n");
  });

  test("leaves no temporary directory behind", () => {
    prepare();
    prepare("0".repeat(64));
    const moduleDir = join(runtimeRoot, moduleId);
    expect(existsSync(moduleDir)).toBe(true);
    expect(readdirSync(moduleDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  test("uninstall removes every snapshot of the module", () => {
    const snapshot = prepare();
    if (!snapshot.ok) throw new Error(snapshot.reason);
    removeNativeSnapshots(moduleId);
    expect(existsSync(join(runtimeRoot, moduleId))).toBe(false);
  });

  test("collection keeps referenced and recent snapshots and removes old unreferenced ones", () => {
    const current = prepare();
    if (!current.ok) throw new Error(current.reason);
    writeFileSync(join(installPath, "dist", "index.js"), "export default 2;\n");
    const older = prepare();
    if (!older.ok) throw new Error(older.reason);

    // Nothing is old enough yet.
    expect(collectNativeSnapshots(new Set([current.root]))).toEqual([]);

    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(older.root, longAgo, longAgo);
    utimesSync(current.root, longAgo, longAgo);
    expect(collectNativeSnapshots(new Set([current.root]))).toEqual([older.root]);
    expect(existsSync(older.root)).toBe(false);
    expect(existsSync(current.root)).toBe(true);
  });
});
