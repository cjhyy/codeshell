import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("session workspace, archive and parent filters apply before the requested limit", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-session-list-filter-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  const wanted = manager.create(join(root, "workspace"), "model", "provider");
  utimesSync(join(root, "sessions", wanted.state.sessionId, "transcript.jsonl"), 1000, 1000);
  for (let index = 0; index < 24; index++) {
    const other = manager.create(join(root, "elsewhere"), "model", "provider");
    utimesSync(
      join(root, "sessions", other.state.sessionId, "transcript.jsonl"),
      2000 + index,
      2000 + index,
    );
  }
  const archived = manager.create(wanted.state.cwd, "model", "provider");
  manager.setSessionArchived(archived.state.sessionId, 123);
  const child = manager.create(wanted.state.cwd, "model", "provider");
  manager.updateSessionState(child.state.sessionId, { parentSessionId: wanted.state.sessionId });
  expect(
    manager
      .list(1, { cwd: wanted.state.cwd, archived: false, rootsOnly: true })
      .map((item) => item.sessionId),
  ).toEqual([wanted.state.sessionId]);
  expect(
    manager.list(1, { cwd: wanted.state.cwd, archived: true }).map((item) => item.sessionId),
  ).toEqual([archived.state.sessionId]);
});

test("stable activity cursor does not repeat tied sessions and supports host title filters", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-session-list-cursor-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  for (let index = 0; index < 4; index++) {
    const { state } = manager.create(join(root, "workspace"), "model", "provider");
    manager.updateSessionState(state.sessionId, { title: index < 3 ? "match" : "hidden" });
    utimesSync(join(root, "sessions", state.sessionId, "transcript.jsonl"), 2000, 2000);
  }
  const filter = (state: { title?: string }) => state.title === "match";
  const first = manager.list(2, { filter });
  const last = first.at(-1)!;
  const second = manager.list(2, {
    filter,
    before: { lastActiveAt: last.lastActiveAt, sessionId: last.sessionId },
  });
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(1);
  expect(new Set([...first, ...second].map((entry) => entry.sessionId)).size).toBe(3);
});

test("listing rejects linked, oversized and mismatched session metadata before returning private previews", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-session-list-unsafe-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  const safe = manager.create(join(root, "workspace"), "model", "provider");
  const linked = manager.create(safe.state.cwd, "model", "provider");
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, '{"type":"message","data":{"role":"user","content":"private preview"}}\n');
  const linkedTranscript = join(root, "sessions", linked.state.sessionId, "transcript.jsonl");
  rmSync(linkedTranscript);
  symlinkSync(outside, linkedTranscript);
  const oversized = manager.create(safe.state.cwd, "model", "provider");
  writeFileSync(
    join(root, "sessions", oversized.state.sessionId, "state.json"),
    JSON.stringify({ ...oversized.state, title: "x".repeat(1024 * 1024) }),
  );
  const mismatched = manager.create(safe.state.cwd, "model", "provider");
  writeFileSync(
    join(root, "sessions", mismatched.state.sessionId, "state.json"),
    JSON.stringify({ ...mismatched.state, sessionId: safe.state.sessionId }),
  );
  const linkedState = manager.create(safe.state.cwd, "model", "provider");
  const stateFile = join(root, "sessions", linkedState.state.sessionId, "state.json");
  rmSync(stateFile);
  symlinkSync(join(root, "sessions", safe.state.sessionId, "state.json"), stateFile);
  expect(manager.list(20).map((entry) => entry.sessionId)).toEqual([safe.state.sessionId]);
  expect(readFileSync(outside, "utf8")).toContain("private preview");
});

test("raw preview line breaks survive for host attachment projection and optional tail scans stay bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-session-list-preview-"));
  roots.push(root);
  const manager = new SessionManager(join(root, "sessions"));
  const { state, transcript } = manager.create(join(root, "workspace"), "model", "provider");
  const wrapper =
    '<attached-file path="report.txt">\nabsolutePath: /private/report.txt\norigin: upload\n</attached-file>\nVisible request';
  transcript.append("message", { role: "user", content: wrapper });
  expect(manager.list(1)[0]?.preview).toBe(wrapper);
  transcript.append("message", { role: "assistant", content: "x".repeat(3 * 1024 * 1024) });
  expect(manager.list(1)[0]?.preview).toBeUndefined();
  expect(manager.list(1)[0]?.sessionId).toBe(state.sessionId);
});
