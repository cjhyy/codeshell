import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _pluginTreeDigestCacheStats,
  _resetPluginTreeDigestCache,
  computePluginTreeDigest,
  pluginContentInstallRecord,
  pluginContentState,
  pluginTreeDigest,
} from "./pluginTreeDigest.js";
import type { PluginInstallEntry } from "./types.js";
import {
  inspectPluginHooks,
  MAX_PLUGIN_HOOK_COMMAND_LENGTH,
  MAX_PLUGIN_HOOK_COMMANDS,
  MAX_PLUGIN_HOOK_EVENTS,
  MAX_PLUGIN_HOOK_FILE_BYTES,
  MAX_PLUGIN_HOOK_GROUPS,
  MAX_PLUGIN_HOOK_MATCHER_LENGTH,
  MAX_PLUGIN_HOOK_TIMEOUT_MS,
  pluginHasExecutableHooks,
  pluginHookInstallRecord,
  pluginHookReviewSnapshot,
} from "./pluginHookIntegrity.js";

describe("plugin hook integrity snapshot", () => {
  let root: string;
  let installPath: string;
  let hooksPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugin-hook-integrity-"));
    installPath = join(root, "plugin");
    hooksPath = join(installPath, "hooks", "hooks.json");
    mkdirSync(join(installPath, "hooks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeHooks(hooks: Record<string, unknown>): void {
    writeFileSync(hooksPath, JSON.stringify({ hooks }));
  }

  test("rejects an oversized canonical file before parsing it", () => {
    writeFileSync(hooksPath, Buffer.alloc(MAX_PLUGIN_HOOK_FILE_BYTES + 1, 0x20));

    const snapshot = inspectPluginHooks(installPath);
    expect(snapshot.state).toBe("invalid");
    expect(snapshot.error).toContain("exceeds");
    expect(snapshot.definition).toBeNull();
    expect(pluginHasExecutableHooks(installPath)).toBe(false);
  });

  test("rejects a canonical hooks file symlink", () => {
    const outside = join(root, "outside.json");
    writeFileSync(
      outside,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo escaped" }] }],
        },
      }),
    );
    symlinkSync(outside, hooksPath);

    const snapshot = inspectPluginHooks(installPath);
    expect(snapshot.state).toBe("invalid");
    expect(snapshot.error).toContain("regular file");
    expect(snapshot.definition).toBeNull();
    expect(pluginHookInstallRecord(installPath).approvedHookDigest).toBeUndefined();
  });

  test.each([
    {
      label: "events",
      hooks: Object.fromEntries(
        Array.from({ length: MAX_PLUGIN_HOOK_EVENTS + 1 }, (_, index) => [`Event${index}`, []]),
      ),
    },
    {
      label: "groups",
      hooks: {
        SessionStart: Array.from({ length: MAX_PLUGIN_HOOK_GROUPS + 1 }, () => ({ hooks: [] })),
      },
    },
    {
      label: "commands",
      hooks: {
        SessionStart: [
          {
            hooks: Array.from({ length: MAX_PLUGIN_HOOK_COMMANDS + 1 }, () => ({
              type: "command",
              command: "echo bounded",
            })),
          },
        ],
      },
    },
  ])("rejects definitions over the $label limit", ({ hooks }) => {
    writeHooks(hooks);
    const snapshot = inspectPluginHooks(installPath);
    expect(snapshot.state).toBe("invalid");
    expect(snapshot.error).toContain("more than");
    expect(snapshot.definition).toBeNull();
  });

  test.each([
    {
      label: "command length",
      group: {
        hooks: [
          {
            type: "command",
            command: "x".repeat(MAX_PLUGIN_HOOK_COMMAND_LENGTH + 1),
          },
        ],
      },
    },
    {
      label: "matcher syntax",
      group: {
        matcher: "[",
        hooks: [{ type: "command", command: "echo invalid matcher" }],
      },
    },
    {
      label: "timeout",
      group: {
        hooks: [
          {
            type: "command",
            command: "echo invalid timeout",
            timeout_ms: MAX_PLUGIN_HOOK_TIMEOUT_MS + 1,
          },
        ],
      },
    },
  ])("rejects an invalid $label", ({ group }) => {
    writeHooks({ SessionStart: [group] });
    expect(inspectPluginHooks(installPath).state).toBe("invalid");
  });

  test("accepts definitions exactly at every count and field boundary", () => {
    const hooks: Record<string, unknown> = {};
    const groupsPerEvent = MAX_PLUGIN_HOOK_GROUPS / MAX_PLUGIN_HOOK_EVENTS;
    const commandsPerGroup = MAX_PLUGIN_HOOK_COMMANDS / MAX_PLUGIN_HOOK_GROUPS;

    for (let eventIndex = 0; eventIndex < MAX_PLUGIN_HOOK_EVENTS; eventIndex += 1) {
      const eventName =
        eventIndex === 0
          ? "SessionStart"
          : eventIndex === MAX_PLUGIN_HOOK_EVENTS - 1
            ? "E".repeat(128)
            : `FutureEvent${eventIndex}`;
      hooks[eventName] = Array.from({ length: groupsPerEvent }, (_, groupIndex) => ({
        ...(eventIndex === 0 && groupIndex === 0
          ? { matcher: "a".repeat(MAX_PLUGIN_HOOK_MATCHER_LENGTH) }
          : {}),
        hooks: Array.from({ length: commandsPerGroup }, (_, commandIndex) => ({
          type: "command",
          command:
            eventIndex === 0 && groupIndex === 0 && commandIndex === 0
              ? "x".repeat(MAX_PLUGIN_HOOK_COMMAND_LENGTH)
              : "echo bounded",
          ...(eventIndex === 0 && groupIndex === 0 && commandIndex === 0
            ? { async: true, timeout_ms: MAX_PLUGIN_HOOK_TIMEOUT_MS }
            : {}),
        })),
      }));
    }

    writeHooks(hooks);
    const snapshot = inspectPluginHooks(installPath);
    expect(snapshot.state).toBe("valid");
    expect(snapshot.hasExecutableHooks).toBe(true);
    expect(snapshot.definition?.hooks.SessionStart).toHaveLength(groupsPerEvent);
    expect(snapshot.definition?.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
      command: "x".repeat(MAX_PLUGIN_HOOK_COMMAND_LENGTH),
      async: true,
      timeoutMs: MAX_PLUGIN_HOOK_TIMEOUT_MS,
    });
    const review = pluginHookReviewSnapshot(snapshot);
    expect(review[0]).toMatchObject({
      rawEvent: "SessionStart",
      commandTruncated: true,
      async: true,
      timeoutMs: MAX_PLUGIN_HOOK_TIMEOUT_MS,
    });
    expect(review[0]?.command.length).toBe(4_096);
    expect(review[0]?.commandDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("plugin tree digest", () => {
  let root: string;
  let installPath: string;

  beforeEach(() => {
    _resetPluginTreeDigestCache();
    root = mkdtempSync(join(tmpdir(), "plugin-tree-digest-"));
    installPath = join(root, "plugin");
    mkdirSync(join(installPath, "scripts"), { recursive: true });
    writeFileSync(join(installPath, "scripts", "run.sh"), "echo one\n");
    writeFileSync(join(installPath, "README.md"), "demo\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function digest(path = installPath): string {
    const result = computePluginTreeDigest(path);
    if (!result.ok) throw new Error(result.reason);
    return result.digest;
  }

  test("is a stable sha256 that does not depend on creation order", () => {
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "README.md"), "demo\n");
    mkdirSync(join(other, "scripts"));
    writeFileSync(join(other, "scripts", "run.sh"), "echo one\n");

    expect(digest()).toMatch(/^[a-f0-9]{64}$/);
    expect(digest()).toBe(digest());
    expect(digest(other)).toBe(digest());
  });

  test("changes when any byte, name or entry kind inside the tree changes", () => {
    const before = digest();

    writeFileSync(join(installPath, "scripts", "run.sh"), "echo two\n");
    const edited = digest();
    expect(edited).not.toBe(before);

    writeFileSync(join(installPath, "scripts", "run.sh"), "echo one\n");
    expect(digest()).toBe(before);

    writeFileSync(join(installPath, "scripts", "extra.py"), "");
    const added = digest();
    expect(added).not.toBe(before);
    unlinkSync(join(installPath, "scripts", "extra.py"));

    renameSync(join(installPath, "scripts", "run.sh"), join(installPath, "scripts", "run2.sh"));
    expect(digest()).not.toBe(before);
    renameSync(join(installPath, "scripts", "run2.sh"), join(installPath, "scripts", "run.sh"));

    // An empty file and an empty directory with the same name are different trees.
    writeFileSync(join(installPath, "thing"), "");
    const asFile = digest();
    unlinkSync(join(installPath, "thing"));
    mkdirSync(join(installPath, "thing"));
    expect(digest()).not.toBe(asFile);
  });

  test("covers dependency and cache directories instead of skipping them", () => {
    const before = digest();
    mkdirSync(join(installPath, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(installPath, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const withDependency = digest();
    expect(withDependency).not.toBe(before);

    mkdirSync(join(installPath, "scripts", "__pycache__"));
    writeFileSync(join(installPath, "scripts", "__pycache__", "run.pyc"), "bytecode");
    expect(digest()).not.toBe(withDependency);
  });

  test("ignores only the installer's own root metadata and the root git directory", () => {
    const before = digest();
    writeFileSync(join(installPath, ".cs-meta.json"), JSON.stringify({ installedAt: "t1" }));
    writeFileSync(join(installPath, ".code-shell-installed.json"), JSON.stringify({ at: "t1" }));
    mkdirSync(join(installPath, ".git"));
    writeFileSync(join(installPath, ".git", "index"), "volatile");
    expect(digest()).toBe(before);

    writeFileSync(join(installPath, ".cs-meta.json"), JSON.stringify({ installedAt: "t2" }));
    expect(digest()).toBe(before);

    // The same names below the root are plugin content and stay covered.
    writeFileSync(join(installPath, "scripts", ".cs-meta.json"), "{}");
    const nestedMeta = digest();
    expect(nestedMeta).not.toBe(before);
    mkdirSync(join(installPath, "scripts", ".git"));
    writeFileSync(join(installPath, "scripts", ".git", "hook.sh"), "echo hidden\n");
    expect(digest()).not.toBe(nestedMeta);
  });

  test("ignores the metadata file Finder leaves behind when a directory is opened", () => {
    const before = digest();
    writeFileSync(join(installPath, ".DS_Store"), "finder view state");
    writeFileSync(join(installPath, "scripts", ".DS_Store"), "finder view state");
    expect(digest()).toBe(before);

    // Nothing else that merely looks like OS metadata is exempt.
    writeFileSync(join(installPath, "scripts", "Thumbs.db"), "not exempt");
    expect(digest()).not.toBe(before);
  });

  test("records a symlink's target string without reading what it points to", () => {
    const outside = join(root, "outside.sh");
    writeFileSync(outside, "echo outside one\n");
    symlinkSync(outside, join(installPath, "scripts", "link.sh"));
    const before = digest();

    writeFileSync(outside, "echo outside two\n");
    expect(digest()).toBe(before);

    unlinkSync(join(installPath, "scripts", "link.sh"));
    symlinkSync(join(root, "elsewhere.sh"), join(installPath, "scripts", "link.sh"));
    expect(digest()).not.toBe(before);
  });

  test("fails closed for a missing, non-directory or symlinked install root", () => {
    expect(computePluginTreeDigest(join(root, "missing")).ok).toBe(false);
    expect(computePluginTreeDigest(join(installPath, "README.md")).ok).toBe(false);
    symlinkSync(installPath, join(root, "alias"));
    expect(computePluginTreeDigest(join(root, "alias")).ok).toBe(false);
  });

  test("fails closed when the tree exceeds an entry, byte or depth limit", () => {
    expect(computePluginTreeDigest(installPath, { maxEntries: 3 }).ok).toBe(true);
    const tooMany = computePluginTreeDigest(installPath, { maxEntries: 2 });
    expect(tooMany).toMatchObject({ ok: false });
    expect(tooMany.ok ? "" : tooMany.reason).toContain("entries");

    const tooLarge = computePluginTreeDigest(installPath, { maxBytes: 8 });
    expect(tooLarge.ok ? "" : tooLarge.reason).toContain("bytes");

    expect(computePluginTreeDigest(installPath, { maxDepth: 1 }).ok).toBe(true);
    const tooDeep = computePluginTreeDigest(installPath, { maxDepth: 0 });
    expect(tooDeep.ok ? "" : tooDeep.reason).toContain("depth");
  });

  test("reuses a quiescent tree's digest and recomputes after any change", () => {
    const later = () => Date.now() + 10_000;
    const first = pluginTreeDigest(installPath, { now: later });
    expect(first).toEqual({ ok: true, digest: digest() });
    expect(_pluginTreeDigestCacheStats()).toEqual({ hits: 0, misses: 1 });

    expect(pluginTreeDigest(installPath, { now: later })).toEqual(first);
    expect(_pluginTreeDigestCacheStats()).toEqual({ hits: 1, misses: 1 });

    writeFileSync(join(installPath, "scripts", "run.sh"), "echo two\n");
    const changed = pluginTreeDigest(installPath, { now: later });
    expect(changed).toEqual({ ok: true, digest: digest() });
    expect(changed).not.toEqual(first);
    expect(_pluginTreeDigestCacheStats()).toEqual({ hits: 1, misses: 2 });
  });

  test("never caches a tree that was modified within the racy window", () => {
    pluginTreeDigest(installPath);
    pluginTreeDigest(installPath);
    expect(_pluginTreeDigestCacheStats()).toEqual({ hits: 0, misses: 2 });
  });

  function entry(fields: Partial<PluginInstallEntry> = {}): PluginInstallEntry {
    return {
      scope: "user",
      installPath,
      version: "1.0.0",
      installedAt: "t1",
      lastUpdated: "t1",
      ...fields,
    };
  }

  test("install records start unapproved and keep approval only for identical bytes", () => {
    const fresh = pluginContentInstallRecord(installPath);
    expect(fresh).toEqual({ contentDigest: digest() });

    const approved = entry({ contentDigest: digest(), approvedContentDigest: digest() });
    expect(pluginContentInstallRecord(installPath, [approved])).toEqual({
      contentDigest: digest(),
      approvedContentDigest: digest(),
    });

    writeFileSync(join(installPath, "scripts", "run.sh"), "echo updated\n");
    expect(pluginContentInstallRecord(installPath, [approved])).toEqual({
      contentDigest: digest(),
    });
  });

  test("an undigestable tree gets no content record at all", () => {
    expect(pluginContentInstallRecord(join(root, "missing"))).toEqual({});
  });

  test("content state comes from the install record; local edits do not touch it", () => {
    expect(pluginContentState(entry())).toBe("unrecorded");
    expect(pluginContentState(entry({ contentDigest: digest() }))).toBe("unapproved");
    const approved = entry({ contentDigest: digest(), approvedContentDigest: digest() });
    expect(pluginContentState(approved)).toBe("approved");

    writeFileSync(join(installPath, "scripts", "run.sh"), "echo edited locally\n");
    expect(pluginContentState(approved)).toBe("approved");
    rmSync(installPath, { recursive: true, force: true });
    expect(pluginContentState(approved)).toBe("approved");
  });
});
