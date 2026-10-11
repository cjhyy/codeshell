import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager";
import { lockSync } from "../utils/lockfile.js";

async function collect(ids: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const id of ids) result.push(id);
  return result.sort();
}

describe("SessionManager digital-human reference scan", () => {
  test("conditionally clears a binding without overwriting another metadata writer", () => {
    const root = mkdtempSync(join(tmpdir(), "session-profile-clear-"));
    try {
      const manager = new SessionManager(root);
      manager.create(root, "model", "provider", "bound");
      manager.updateSessionState("bound", { workspaceProfile: "researcher", title: "kept" });
      expect(manager.clearSessionWorkspaceProfile("bound", "researcher")).toBe(true);
      expect(manager.readSessionState("bound")).toMatchObject({ title: "kept" });
      expect(manager.readSessionWorkspaceProfile("bound")).toBeUndefined();

      manager.updateSessionState("bound", { workspaceProfile: "developer" });
      const file = join(root, "bound", "state.json");
      const before = readFileSync(file, "utf8");
      const release = lockSync(file, { stale: 10_000, retries: 0, realpath: false });
      try {
        // A different owner is a genuine no-op, even when writes are locked.
        expect(manager.clearSessionWorkspaceProfile("bound", "researcher")).toBe(false);
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(() => manager.clearSessionWorkspaceProfile("bound", "developer")).toThrow(
          /lock contention/,
        );
      } finally {
        release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rechecks the binding when a real competing write wins the state CAS", () => {
    const root = mkdtempSync(join(tmpdir(), "session-profile-clear-cas-"));
    try {
      const manager = new SessionManager(root);
      const other = new SessionManager(root);
      manager.create(root, "model", "provider", "bound");
      manager.updateSessionState("bound", { workspaceProfile: "researcher" });
      const internal = manager as any;
      const save = internal.saveStateAttempt.bind(manager);
      let attempts = 0;
      const probe = spyOn(internal, "saveStateAttempt").mockImplementation((...args) => {
        if (++attempts === 1) {
          other.updateSessionState("bound", { workspaceProfile: "developer", title: "new" });
        }
        return save(...args);
      });
      try {
        expect(manager.clearSessionWorkspaceProfile("bound", "researcher")).toBe(false);
        expect(attempts).toBe(1);
        expect(manager.readSessionState("bound")).toMatchObject({
          workspaceProfile: "developer",
          title: "new",
          stateRevision: 2,
        });
      } finally {
        probe.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finds bounded regular state files and isolates unsafe entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-profile-references-"));
    try {
      const manager = new SessionManager(root);
      for (const [id, workspaceProfile] of [
        ["session-b", "researcher"],
        ["session-a", "researcher"],
        ["session-c", "developer"],
      ] as const) {
        mkdirSync(join(root, id));
        writeFileSync(join(root, id, "state.json"), JSON.stringify({ workspaceProfile }));
      }
      mkdirSync(join(root, "qchat-ignored"));
      writeFileSync(
        join(root, "qchat-ignored", "state.json"),
        JSON.stringify({ workspaceProfile: "researcher" }),
      );
      for (const [id, value] of [
        ["corrupt-null", "null"],
        ["corrupt-json", "{"],
      ]) {
        mkdirSync(join(root, id));
        writeFileSync(join(root, id, "state.json"), value);
      }
      if (process.platform !== "win32") {
        const outside = join(root, "outside-state.json");
        writeFileSync(outside, JSON.stringify({ workspaceProfile: "researcher" }));
        mkdirSync(join(root, "session-linked"));
        symlinkSync(outside, join(root, "session-linked", "state.json"));
      }

      expect(manager.findSessionIdsByWorkspaceProfile("researcher")).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(manager.findSessionIdsByWorkspaceProfile("researcher", 1)).toHaveLength(1);
      expect(manager.findSessionIdsByWorkspaceProfile("developer")).toEqual(["session-c"]);
      expect(manager.findSessionIdsByWorkspaceProfile("")).toEqual([]);
      expect(await collect(manager.iterateSessionIdsByWorkspaceProfile("researcher"))).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(await collect(manager.iterateSessionIdsByWorkspaceProfile(""))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can skip archived Sessions, which are history rather than live bindings", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-profile-archived-"));
    try {
      const manager = new SessionManager(root);
      mkdirSync(join(root, "session-live"));
      writeFileSync(
        join(root, "session-live", "state.json"),
        JSON.stringify({ workspaceProfile: "researcher" }),
      );
      mkdirSync(join(root, "session-archived"));
      writeFileSync(
        join(root, "session-archived", "state.json"),
        JSON.stringify({ workspaceProfile: "researcher", archivedAt: 1785137194100 }),
      );

      // Default stays inclusive so existing callers keep their semantics.
      expect(manager.findSessionIdsByWorkspaceProfile("researcher")).toEqual([
        "session-archived",
        "session-live",
      ]);
      expect(
        manager.findSessionIdsByWorkspaceProfile("researcher", 20, { includeArchived: false }),
      ).toEqual(["session-live"]);
      expect(await collect(manager.iterateSessionIdsByWorkspaceProfile("researcher"))).toEqual([
        "session-archived",
        "session-live",
      ]);
      expect(
        await collect(
          manager.iterateSessionIdsByWorkspaceProfile("researcher", {
            includeArchived: false,
          }),
        ),
      ).toEqual(["session-live"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
