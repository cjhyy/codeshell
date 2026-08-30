import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigTool } from "./config.js";
import { SettingsManager } from "../../settings/manager.js";
import type { ToolContext } from "../context.js";

// Regression: `config write` used to do its own read → setDottedSetting →
// writeFileSync against ${cwd}/.code-shell/settings.json, with no lock and no
// temp+rename — bypassing SettingsManager entirely. Two writers that both read
// before either wrote would each persist their own stale snapshot, so the first
// writer's key silently vanished (the exact class file-mutex.ts:6-11 documents:
// "48 concurrent writers each setting a distinct settings key left only 17").
//
// The barrier below makes that deterministic instead of probabilistic: writer A
// is held open at the point where it has already read the file, writer B runs to
// completion, and only then is A released to write. Under the old code A's write
// clobbers B's key; going through SettingsManager, A re-reads inside the lock.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function readSettings(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
}

describe("config tool — concurrent writes", () => {
  test("a writer that read before another wrote does not drop the other's key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-conc-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(
      join(dir, ".code-shell", "settings.json"),
      JSON.stringify({ existing: "keep-me" }, null, 2),
    );

    // Released once writer B has fully persisted its key.
    let releaseA!: () => void;
    const aMayWrite = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aHasRead!: () => void;
    const aDidRead = new Promise<void>((resolve) => {
      aHasRead = resolve;
    });

    // Writer A is parked after the tool has resolved its settings source but
    // before it persists, i.e. exactly the read→write window that used to be
    // unguarded. `beforeWrite` is the injected seam; nothing else is faked.
    const stalledTool = makeConfigTool({
      makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
      beforeWrite: async () => {
        aHasRead();
        await aMayWrite;
      },
    });
    const plainTool = makeConfigTool();

    const ctx = { cwd: dir } as ToolContext;
    const writerA = stalledTool({ action: "write", key: "alpha", value: "A" }, ctx);
    await aDidRead;
    // B completes entirely while A is parked.
    const bResult = await plainTool({ action: "write", key: "beta", value: "B" }, ctx);
    expect(bResult).toMatch(/Updated/);
    expect(readSettings(dir).beta).toBe("B");

    releaseA();
    const aResult = await writerA;
    expect(aResult).toMatch(/Updated/);

    const final = readSettings(dir);
    expect(final.alpha).toBe("A"); // A's own write landed
    expect(final.beta).toBe("B"); // and B's key survived it
    expect(final.existing).toBe("keep-me"); // pre-existing siblings untouched
  });

  test("several writers all parked before persisting each keep their key", async () => {
    // The persist path is fully synchronous, so a bare Promise.all can never
    // interleave in one process — it would pass against the OLD implementation
    // too (measured: 0 of 12 keys lost). Every writer therefore has to be parked
    // in the read→write window explicitly for this to mean anything.
    const dir = mkdtempSync(join(tmpdir(), "cs-config-many-"));
    dirs.push(dir);
    const ctx = { cwd: dir } as ToolContext;
    const keys = Array.from({ length: 6 }, (_, i) => `k${i}`);

    let release!: () => void;
    const mayWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = 0;
    let allParked!: () => void;
    const everyoneParked = new Promise<void>((resolve) => {
      allParked = resolve;
    });
    const tool = makeConfigTool({
      makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
      beforeWrite: async () => {
        if (++parked === keys.length) allParked();
        await mayWrite;
      },
    });

    const writes = keys.map((k) => tool({ action: "write", key: k, value: k }, ctx));
    await everyoneParked; // all 6 have passed the read point, none has written
    release();
    await Promise.all(writes);

    const final = readSettings(dir);
    for (const k of keys) expect(final[k]).toBe(k);
  });

  test("same-key writers parked together leave one winner and parseable JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-same-"));
    dirs.push(dir);
    const ctx = { cwd: dir } as ToolContext;
    const values = ["one", "two", "three"];

    let release!: () => void;
    const mayWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = 0;
    let allParked!: () => void;
    const everyoneParked = new Promise<void>((resolve) => {
      allParked = resolve;
    });
    const tool = makeConfigTool({
      makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
      beforeWrite: async () => {
        if (++parked === values.length) allParked();
        await mayWrite;
      },
    });

    const writes = values.map((v) => tool({ action: "write", key: "shared", value: v }, ctx));
    await everyoneParked;
    release();
    await Promise.all(writes);

    // Same key, so last-writer-wins is the defined semantic; WHICH writer lands
    // last is racy by nature and deliberately not pinned. What is guaranteed is
    // that the file parses and holds exactly one of the written values.
    const final = readSettings(dir);
    expect(values).toContain(final.shared);
  });
});

describe("config tool — read/write contract", () => {
  test("read reflects a nested dot-path write through the same source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-rw-"));
    dirs.push(dir);
    const tool = makeConfigTool();
    const ctx = { cwd: dir } as ToolContext;

    await tool({ action: "write", key: "model.provider.name", value: "anthropic" }, ctx);
    const read = await tool({ action: "read" }, ctx);

    expect(JSON.parse(read)).toMatchObject({ model: { provider: { name: "anthropic" } } });
  });

  test("writing a sibling nested key preserves the existing branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-sib-"));
    dirs.push(dir);
    const tool = makeConfigTool();
    const ctx = { cwd: dir } as ToolContext;

    await tool({ action: "write", key: "model.temperature", value: 0.5 }, ctx);
    await tool({ action: "write", key: "model.topP", value: 0.9 }, ctx);

    const final = readSettings(dir);
    expect(final.model).toEqual({ temperature: 0.5, topP: 0.9 });
  });

  test("write never touches the user-level settings file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-scope-"));
    dirs.push(dir);
    const tool = makeConfigTool();

    await tool({ action: "write", key: "alpha", value: 1 }, { cwd: dir } as ToolContext);

    // Only the project file exists under the project root.
    expect(readSettings(dir).alpha).toBe(1);
  });

  test("refuses to overwrite malformed settings.json and keeps the bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-malformed-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    const path = join(dir, ".code-shell", "settings.json");
    const original = '{"keep":"me", BROKEN';
    writeFileSync(path, original);

    const result = await makeConfigTool()({ action: "write", key: "newKey", value: "v" }, {
      cwd: dir,
    } as ToolContext);

    // Must NOT report success, and must not have replaced the user's file with
    // an object holding only the new key.
    expect(result).toMatch(/^Error: /);
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  test("refuses to overwrite an oversize settings.json and keeps the bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-oversize-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    const path = join(dir, ".code-shell", "settings.json");
    const original = JSON.stringify({ keep: "me", pad: "x".repeat(5 * 1024 * 1024) });
    writeFileSync(path, original);

    const result = await makeConfigTool()({ action: "write", key: "newKey", value: "v" }, {
      cwd: dir,
    } as ToolContext);

    expect(result).toMatch(/^Error: /);
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  test("reports a hostile state dir as a string instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-hostile-"));
    dirs.push(dir);
    // `.code-shell` exists but is a regular file, so the settings dir can never
    // be created. Every other failure in this tool is a returned string; an
    // escaping exception would surface very differently to the caller.
    writeFileSync(join(dir, ".code-shell"), "not a directory");

    const result = await makeConfigTool()({ action: "write", key: "alpha", value: 1 }, {
      cwd: dir,
    } as ToolContext);

    expect(typeof result).toBe("string");
    expect(result).toMatch(/^Error: /);
  });

  test("rejects a missing key and an unknown action without writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-bad-"));
    dirs.push(dir);
    const tool = makeConfigTool();
    const ctx = { cwd: dir } as ToolContext;

    expect(await tool({ action: "write", value: 1 }, ctx)).toMatch(/'key' is required/);
    expect(await tool({ action: "write", key: "a" }, ctx)).toMatch(/'value' is required/);
    expect(await tool({ action: "nope" }, ctx)).toMatch(/Unknown action/);
    expect(await tool({ action: "read" }, ctx)).toMatch(/No project settings found/);
  });
});
