import { describe, it, expect } from "bun:test";
import {
  chmod,
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings, resolveSettingsPath } from "./settings-service.js";

/**
 * Regression (review-2026-06-17):
 *   - readSettings used to rethrow a SyntaxError on a corrupt settings.json,
 *     which rejected settings:get and broke the whole settings page (and every
 *     subsequent settings:set, since writeSettings reads first). It must
 *     degrade to null and back up the bad file.
 *   - writeSettings was an unlocked read-modify-write with a fixed `.tmp` path,
 *     so concurrent settings:set calls lost updates / interleaved temp files.
 *     Concurrent writes to different keys must all survive.
 */
describe("settings-service", () => {
  async function withCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = await mkdtemp(join(tmpdir(), "settings-svc-"));
    try {
      return await fn(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it("degrades a corrupt settings.json to null and backs it up", async () => {
    await withCwd(async (cwd) => {
      const p = resolveSettingsPath("project", cwd);
      await mkdir(join(cwd, ".code-shell"), { recursive: true });
      await writeFile(p, "{ this is not json", "utf8");

      // Must NOT throw — returns null so the UI renders defaults.
      expect(await readSettings("project", cwd)).toBeNull();

      // The corrupt file was backed up (renamed to *.corrupt-*).
      const files = await readdir(join(cwd, ".code-shell"));
      expect(files.some((f) => f.startsWith("settings.json.corrupt-"))).toBe(true);

      // And a subsequent write succeeds (the bad file no longer blocks it).
      await writeSettings("project", { model: { name: "x" } }, cwd);
      expect(await readSettings("project", cwd)).toEqual({ model: { name: "x" } });
    });
  });

  it("quarantines a syntactically valid non-object settings root", async () => {
    await withCwd(async (cwd) => {
      const p = resolveSettingsPath("project", cwd);
      await mkdir(join(cwd, ".code-shell"), { recursive: true });
      await writeFile(p, "[]\n", "utf8");

      expect(await readSettings("project", cwd)).toBeNull();
      expect((await readdir(join(cwd, ".code-shell"))).some((name) => name.includes(".corrupt-"))).toBe(
        true,
      );
    });
  });

  it("drops dangerous legacy keys and rejects them in new patches", async () => {
    await withCwd(async (cwd) => {
      const p = resolveSettingsPath("project", cwd);
      await mkdir(join(cwd, ".code-shell"), { recursive: true });
      await writeFile(
        p,
        '{"safe":true,"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"polluted":true}},"keep":1}}',
        "utf8",
      );

      expect(await readSettings("project", cwd)).toEqual({ safe: true, nested: { keep: 1 } });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const dangerous = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as Record<
        string,
        unknown
      >;
      await expect(writeSettings("project", dangerous, cwd)).rejects.toThrow(/invalid settings key/);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  it("rejects an array-shaped patch root", async () => {
    await withCwd(async (cwd) => {
      await expect(
        writeSettings("project", [] as unknown as Record<string, unknown>, cwd),
      ).rejects.toThrow(/plain object/);
      expect(await readSettings("project", cwd)).toBeNull();
    });
  });

  it("atomic MCP rename: one patch adds new + deletes old (nested null), no old+new leftover", async () => {
    await withCwd(async (cwd) => {
      // Seed an existing server "old".
      await writeSettings(
        "project",
        { mcpServers: { old: { command: "echo", transport: "stdio" } } },
        cwd,
      );
      // Rename old -> new in a SINGLE patch (what McpSection.saveEdit now sends).
      await writeSettings(
        "project",
        { mcpServers: { new: { command: "echo", transport: "stdio" }, old: null } },
        cwd,
      );
      const after = (await readSettings("project", cwd)) as {
        mcpServers?: Record<string, unknown>;
      };
      // Only "new" survives — "old" is gone, and mcpServers wasn't wiped.
      expect(Object.keys(after.mcpServers ?? {})).toEqual(["new"]);
    });
  });

  it("keeps concurrent writes to different keys (no lost updates)", async () => {
    await withCwd(async (cwd) => {
      await Promise.all([
        writeSettings("project", { a: 1 }, cwd),
        writeSettings("project", { b: 2 }, cwd),
        writeSettings("project", { c: 3 }, cwd),
      ]);
      const result = await readSettings("project", cwd);
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });
  });

  it("never leaves the file as corrupt JSON under concurrent writes", async () => {
    await withCwd(async (cwd) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) => writeSettings("project", { [`k${i}`]: i }, cwd)),
      );
      const p = resolveSettingsPath("project", cwd);
      const raw = await readFile(p, "utf8");
      // The final file must be valid JSON (never a half-written interleave).
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  it("creates settings owner-only and tightens a legacy world-readable file", async () => {
    await withCwd(async (cwd) => {
      const p = resolveSettingsPath("project", cwd);
      await writeSettings("project", { credentials: [{ apiKey: "sk-secret" }] }, cwd);
      if (process.platform !== "win32") expect((await stat(p)).mode & 0o777).toBe(0o600);

      await chmod(p, 0o644);
      await writeSettings("project", { another: true }, cwd);
      if (process.platform !== "win32") expect((await stat(p)).mode & 0o777).toBe(0o600);
      expect((await readdir(join(cwd, ".code-shell"))).some((name) => name.endsWith(".tmp"))).toBe(
        false,
      );
    });
  });

  it("rejects an invalid worktree branchPrefix before writing settings", async () => {
    await withCwd(async (cwd) => {
      await expect(
        writeSettings("project", { worktree: { branchPrefix: "../bad/" } }, cwd),
      ).rejects.toThrow(/invalid worktree branch prefix/i);
      expect(await readSettings("project", cwd)).toBeNull();

      await writeSettings("project", { worktree: { branchPrefix: "agent" } }, cwd);
      expect(await readSettings("project", cwd)).toEqual({
        worktree: { branchPrefix: "agent/" },
      });
    });
  });
});

describe("null-valued patch keys never reach disk", () => {
  // Regression: `{a: {b: null}}` written onto a file with NO `a` key used to
  // land the null verbatim, because the delete branch only ran once deepMerge
  // had recursed into an existing object. The settings schema then rejected the
  // entire file, and readers that fail closed on a parse error behaved as if
  // the project had configured nothing at all.
  it("deletes a nested key even when the parent does not exist yet", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "settings-null-"));
    await writeSettings("project", { panelAppBindings: ["job-hunt-hq"] }, cwd);
    await writeSettings("project", { panelAppOverrides: { "job-hunt-hq": null } }, cwd);
    const after = (await readSettings("project", cwd)) as Record<string, any>;
    expect(after.panelAppOverrides).toEqual({});
    expect(JSON.stringify(after)).not.toContain("null");
  });

  it("keeps sibling values while dropping the null", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "settings-null-"));
    await writeSettings("project", { panelAppOverrides: { keep: "on", drop: null } }, cwd);
    const after = (await readSettings("project", cwd)) as Record<string, any>;
    expect(after.panelAppOverrides).toEqual({ keep: "on" });
  });

  it("still deletes a top-level key outright", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "settings-null-"));
    await writeSettings("project", { panelAppBindings: ["a"] }, cwd);
    await writeSettings("project", { panelAppBindings: null }, cwd);
    const after = (await readSettings("project", cwd)) as Record<string, any>;
    expect("panelAppBindings" in after).toBe(false);
  });
});
