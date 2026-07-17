import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
