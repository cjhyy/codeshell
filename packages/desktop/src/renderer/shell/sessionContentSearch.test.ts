import { describe, expect, test } from "bun:test";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import { parseContentQuery, resolveContentMatch } from "./sessionContentSearch";

function summary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: "untitled",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function index(sessions: SessionSummary[]): SessionIndex {
  return { sessions, activeSessionId: null };
}

describe("parseContentQuery", () => {
  test("no '>' prefix stays in title mode", () => {
    expect(parseContentQuery("hello")).toEqual({ contentMode: false, term: "", ready: false });
    expect(parseContentQuery("")).toEqual({ contentMode: false, term: "", ready: false });
  });

  test("bare '>' enters content mode with an empty, not-ready term", () => {
    expect(parseContentQuery(">")).toEqual({ contentMode: true, term: "", ready: false });
  });

  test("'> a' strips the leading space but stays below the 2-char threshold", () => {
    expect(parseContentQuery("> a")).toEqual({ contentMode: true, term: "a", ready: false });
  });

  test("'>ab' is ready at the 2-char boundary", () => {
    expect(parseContentQuery(">ab")).toEqual({ contentMode: true, term: "ab", ready: true });
  });

  test("'> ab' strips leading spaces and is ready", () => {
    expect(parseContentQuery("> ab")).toEqual({ contentMode: true, term: "ab", ready: true });
  });
});

describe("resolveContentMatch", () => {
  const projects = [{ id: "proj-a" }, { id: "proj-b" }];

  test("resolves via engineSessionId", () => {
    const sessions: Record<string, SessionIndex> = {
      "proj-a": index([summary({ id: "local-1", engineSessionId: "engine-1" })]),
    };
    expect(resolveContentMatch({ sessionId: "engine-1" }, projects, sessions)).toEqual({
      projectId: "proj-a",
      sessionId: "local-1",
    });
  });

  test("falls back to matching the local id", () => {
    const sessions: Record<string, SessionIndex> = {
      "proj-b": index([summary({ id: "engine-2" })]),
    };
    expect(resolveContentMatch({ sessionId: "engine-2" }, projects, sessions)).toEqual({
      projectId: "proj-b",
      sessionId: "engine-2",
    });
  });

  test("skips archived sessions", () => {
    const sessions: Record<string, SessionIndex> = {
      "proj-a": index([summary({ id: "local-1", engineSessionId: "engine-1", archived: true })]),
    };
    expect(resolveContentMatch({ sessionId: "engine-1" }, projects, sessions)).toBeNull();
  });

  test("resolves a no-repo match to projectId null via the NO_REPO bucket", () => {
    const sessions: Record<string, SessionIndex> = {
      [NO_REPO_KEY]: index([summary({ id: "local-x", engineSessionId: "engine-x" })]),
    };
    expect(resolveContentMatch({ sessionId: "engine-x" }, projects, sessions)).toEqual({
      projectId: null,
      sessionId: "local-x",
    });
  });

  test("iterates [null, ...projects] in order — no-repo wins a cross-bucket tie", () => {
    const shared = "engine-dup";
    const sessions: Record<string, SessionIndex> = {
      [NO_REPO_KEY]: index([summary({ id: "no-repo-hit", engineSessionId: shared })]),
      "proj-a": index([summary({ id: "proj-hit", engineSessionId: shared })]),
    };
    expect(resolveContentMatch({ sessionId: shared }, projects, sessions)).toEqual({
      projectId: null,
      sessionId: "no-repo-hit",
    });
  });

  test("returns null for a disk-only match with no in-memory session", () => {
    const sessions: Record<string, SessionIndex> = {
      "proj-a": index([summary({ id: "local-1", engineSessionId: "engine-1" })]),
    };
    expect(resolveContentMatch({ sessionId: "engine-missing" }, projects, sessions)).toBeNull();
  });
});
