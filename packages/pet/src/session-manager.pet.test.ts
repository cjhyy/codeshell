import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../exceptions.js";
import { SessionManager } from "./session-manager.js";

describe("SessionManager pet kind", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-pet-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists and resumes a durable pet session with its transcript", () => {
    const manager = new SessionManager(dir);
    const created = manager.create(
      "/tmp",
      "model",
      "provider",
      "local-pet",
      null,
      "desktop",
      "pet",
    );
    created.transcript.appendMessage("user", "hello pet");
    created.transcript.appendMessage("assistant", "hello human");

    const raw = JSON.parse(readFileSync(join(dir, "local-pet", "state.json"), "utf8"));
    expect(raw.kind).toBe("pet");
    expect(raw.ephemeral).toBeUndefined();

    const resumed = new SessionManager(dir).resume("local-pet");
    expect(resumed.state.kind).toBe("pet");
    expect(resumed.transcript.toMessages().map((message) => message.content)).toEqual([
      "hello pet",
      "hello human",
    ]);
    expect(manager.list().map((session) => session.sessionId)).not.toContain("local-pet");
  });

  test("normalizes legacy sessions to work and never rewrites an existing kind", () => {
    const manager = new SessionManager(dir);
    manager.create("/tmp", "model", "provider", "legacy-work");
    const statePath = join(dir, "legacy-work", "state.json");
    const legacy = JSON.parse(readFileSync(statePath, "utf8"));
    delete legacy.kind;
    writeFileSync(statePath, JSON.stringify(legacy));

    expect(manager.readSessionKind("legacy-work")).toBe("work");
    expect(manager.resume("legacy-work").state.kind).toBe("work");
    expect(() => manager.updateSessionState("legacy-work", { kind: "pet" })).toThrow(SessionError);

    const stale = manager.resume("legacy-work");
    stale.state.kind = "pet";
    expect(manager.saveState(stale.state)).toBe(false);
    expect(manager.readSessionKind("legacy-work")).toBe("work");

    manager.create("/tmp", "model", "provider", "pet", null, "desktop", "pet");
    expect(() => manager.updateSessionState("pet", { kind: "work" })).toThrow(SessionError);
  });
});
