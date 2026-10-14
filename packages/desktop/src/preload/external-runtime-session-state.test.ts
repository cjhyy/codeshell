import { expect, test } from "bun:test";
import { subscribeExternalRuntimeSessionState } from "./external-runtime-session-state";

test("late subscriptions recover active ownership and unsubscribe from subsequent changes", () => {
  const active = new Set(["codex-session", "claude-session"]);
  const listeners = new Set<(state: { sessionId: string; active: boolean }) => void>();
  const observed: Array<{ sessionId: string; active: boolean }> = [];
  const unsubscribe = subscribeExternalRuntimeSessionState(active, listeners, (state) =>
    observed.push(state),
  );
  expect(observed).toEqual([
    { sessionId: "codex-session", active: true },
    { sessionId: "claude-session", active: true },
  ]);
  active.delete("codex-session");
  for (const listener of listeners) listener({ sessionId: "codex-session", active: false });
  expect(observed.at(-1)).toEqual({ sessionId: "codex-session", active: false });
  unsubscribe();
  expect(listeners.size).toBe(0);
  const restored: Array<{ sessionId: string; active: boolean }> = [];
  const stopRestored = subscribeExternalRuntimeSessionState(active, listeners, (state) =>
    restored.push(state),
  );
  expect(restored).toEqual([{ sessionId: "claude-session", active: true }]);
  stopRestored();
});
