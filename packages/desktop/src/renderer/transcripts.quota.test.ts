import { afterEach, beforeEach, expect, test } from "bun:test";
import { INITIAL_STATE, type Message, type MessagesReducerState } from "./types";
import {
  bindEngineSession,
  createSession,
  loadSessionIndex,
  saveSessionIndex,
  saveTranscript,
  touchSession,
} from "./transcripts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let items: Map<string, string>;
let maxBytes: number;
let failureName: string | undefined;
const cacheKey = "codeshell.transcript.project.with.dots.old.with.dots";
const indexKey = "codeshell.sessionIndex.project.with.dots";
const projectId = "project.with.dots";
const oldId = "old.with.dots";
const completed: MessagesReducerState = {
  ...INITIAL_STATE,
  sessionId: "engine-old",
  messages: [{ kind: "assistant", id: "answer", text: "x".repeat(10_000), done: true }],
};

function usedBytes(): number {
  return [...items].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0);
}

function seedCache(state = completed, options = { bound: true, active: false }): void {
  saveSessionIndex(projectId, {
    activeSessionId: options.active ? oldId : null,
    sessions: [
      {
        id: oldId,
        title: "Saved conversation",
        createdAt: 1,
        updatedAt: 1,
        pinned: true,
        ...(options.bound ? { engineSessionId: "engine-old" } : {}),
      },
    ],
  });
  saveTranscript(projectId, oldId, state);
  localStorage.setItem("codeshell.preferences", "keep preferences");
  maxBytes = usedBytes();
}

beforeEach(() => {
  items = new Map();
  maxBytes = Infinity;
  failureName = undefined;
  const storage: Storage = {
    get length() {
      return items.size;
    },
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (failureName) throw new DOMException("storage unavailable", failureName);
      const previous = items.get(key);
      const before = previous === undefined ? 0 : (key.length + previous.length) * 2;
      if (usedBytes() - before + (key.length + value.length) * 2 > maxBytes)
        throw new DOMException("storage full", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
});

afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else delete (globalThis as Record<string, unknown>).localStorage;
});

test("reclaims a completed cache so create, title, binding and reload retain the new session", () => {
  seedCache();
  const created = createSession(projectId);
  touchSession(projectId, created.sessionId, "A new Codex conversation");
  bindEngineSession(projectId, created.sessionId, created.sessionId);
  const persisted = JSON.parse(localStorage.getItem(indexKey)!);
  expect(persisted.activeSessionId).toBe(created.sessionId);
  expect(persisted.sessions).toContainEqual(
    expect.objectContaining({
      id: created.sessionId,
      engineSessionId: created.sessionId,
      title: "A new Codex conversation",
    }),
  );
  expect(persisted.sessions).toContainEqual(expect.objectContaining({ id: oldId, pinned: true }));
  expect(localStorage.getItem(cacheKey)).toBeNull();
  expect(localStorage.getItem("codeshell.preferences")).toBe("keep preferences");
  expect(loadSessionIndex(projectId)).toEqual(persisted);
});

test.each([
  { name: "local-only", state: completed, bound: false, active: false },
  { name: "selected", state: completed, bound: true, active: true },
  {
    name: "mismatched binding",
    state: { ...completed, sessionId: "another" },
    bound: true,
    active: false,
  },
  {
    name: "streaming",
    state: { ...completed, streamingAssistantId: "answer" },
    bound: true,
    active: false,
  },
  ...(
    [
      { kind: "user", id: "new-user", text: "not echoed yet" },
      { kind: "user", id: "pending-user", text: "queued", pending: true },
      { kind: "thinking", id: "thinking", text: "working", done: false },
      { kind: "tool", id: "tool", toolName: "Bash", args: "{}", status: "running", startedAt: 1 },
      {
        kind: "ask_user",
        id: "ask",
        requestId: "approval",
        question: "Choose",
        multiSelect: false,
      },
    ] satisfies Message[]
  ).map((message) => ({
    name: `unfinished ${message.kind}`,
    state: { ...completed, messages: [...completed.messages, message] },
    bound: true,
    active: false,
  })),
])(
  "preserves $name cache and keeps the new identity in memory until storage recovers",
  ({ state, bound, active }) => {
    seedCache(state, { bound, active });
    const originalCache = localStorage.getItem(cacheKey);
    const created = createSession(projectId);
    touchSession(projectId, created.sessionId, "Retain this turn");
    bindEngineSession(projectId, created.sessionId, created.sessionId);
    expect(localStorage.getItem(cacheKey)).toBe(originalCache);
    const pending = loadSessionIndex(projectId);
    expect(pending.activeSessionId).toBe(created.sessionId);
    expect(pending.sessions).toContainEqual(
      expect.objectContaining({ id: created.sessionId, title: "Retain this turn" }),
    );
    maxBytes = Infinity;
    saveSessionIndex(projectId, pending);
    expect(JSON.parse(localStorage.getItem(indexKey)!)).toEqual(pending);
  },
);

test("a successful index write from another window supersedes an unpersisted fallback", () => {
  seedCache(completed, { bound: false, active: false });
  const created = createSession(projectId);
  expect(loadSessionIndex(projectId).activeSessionId).toBe(created.sessionId);
  const otherWindow = { sessions: [], activeSessionId: null };
  items.set(indexKey, JSON.stringify(otherWindow));
  expect(loadSessionIndex(projectId)).toEqual(otherWindow);
});

test("does not remove caches for a non-quota storage failure", () => {
  seedCache();
  failureName = "SecurityError";
  createSession(projectId);
  expect(localStorage.getItem(cacheKey)).toBe(JSON.stringify(completed));
});

test("oversized completed histories use disk hydration; local-only tails are preserved", () => {
  seedCache();
  maxBytes = Infinity;
  const oversized = {
    ...completed,
    messages: [{ kind: "assistant", id: "answer", text: "x".repeat(600_000), done: true }],
  } satisfies MessagesReducerState;
  saveTranscript(projectId, oldId, {
    ...oversized,
    streamingAssistantId: "answer",
    messages: [{ ...oversized.messages[0]!, done: false }],
  });
  expect(localStorage.getItem(cacheKey)!.length).toBeGreaterThan(600_000);
  saveTranscript(projectId, oldId, oversized);
  expect(localStorage.getItem(cacheKey)).toBeNull();
  saveTranscript(projectId, "local-only", { ...oversized, sessionId: null });
  expect(localStorage.getItem(`codeshell.transcript.${projectId}.local-only`)).not.toBeNull();
});
