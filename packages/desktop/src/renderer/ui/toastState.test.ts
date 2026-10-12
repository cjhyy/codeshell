import { describe, expect, test } from "bun:test";
import {
  initialToastState,
  addToast,
  dismissToast,
  markToastHistoryRead,
  clearToastHistory,
  toastFromOptions,
  MAX_TOASTS,
  DEFAULT_TOAST_DURATION_MS,
  ERROR_TOAST_DURATION_MS,
  MAX_TOAST_HISTORY,
  type Toast,
  type ToastHistoryEntry,
} from "./toastState";

const mk = (id: string, message = id): Toast => ({
  id,
  message,
  variant: "default",
  durationMs: 0,
});

describe("addToast", () => {
  test("appends to the stack newest-last", () => {
    let s = initialToastState();
    s = addToast(s, mk("a"));
    s = addToast(s, mk("b"));
    expect(s.toasts.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("drops the oldest past MAX_TOASTS", () => {
    let s = initialToastState();
    for (let i = 0; i < MAX_TOASTS + 2; i++) s = addToast(s, mk(`t${i}`));
    expect(s.toasts).toHaveLength(MAX_TOASTS);
    // The two oldest (t0, t1) fell off.
    expect(s.toasts[0]!.id).toBe("t2");
    expect(s.toasts.at(-1)!.id).toBe(`t${MAX_TOASTS + 1}`);
    expect(s.history.map((entry) => entry.id)).toEqual(
      Array.from({ length: MAX_TOASTS + 2 }, (_, index) => `t${index}`),
    );
  });

  test("retains full messages, details, and creation times independently of active toasts", () => {
    const message = "安装失败\n" + "完整错误信息".repeat(300);
    const detail = "command: bun run build\ncwd: /project\n" + "stack trace\n".repeat(400);
    const toast = { ...mk("failure", message), variant: "error" as const, detail };
    const state = addToast(initialToastState(), toast, 1_700_000_000_000);
    expect(state.history).toEqual([{ ...toast, createdAt: 1_700_000_000_000, read: false }]);
    expect(dismissToast(state, toast.id).history).toBe(state.history);
  });

  test("keeps only the newest bounded history without mutating previous state", () => {
    let state = initialToastState();
    for (let index = 0; index < MAX_TOAST_HISTORY; index++) {
      state = addToast(state, mk(`t${index}`), index);
    }
    const next = addToast(state, mk("latest"), MAX_TOAST_HISTORY);
    expect(next.history).toHaveLength(MAX_TOAST_HISTORY);
    expect(next.history[0]!.id).toBe("t1");
    expect(next.history.at(-1)!.id).toBe("latest");
    expect(state.history[0]!.id).toBe("t0");
    expect(next.toasts).toHaveLength(MAX_TOASTS);
  });
});

describe("dismissToast", () => {
  test("removes by id", () => {
    let s = addToast(addToast(initialToastState(), mk("a")), mk("b"));
    s = dismissToast(s, "a");
    expect(s.toasts.map((t) => t.id)).toEqual(["b"]);
    expect(s.history.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("unknown id is a no-op returning the same reference", () => {
    const s = addToast(initialToastState(), mk("a"));
    expect(dismissToast(s, "zzz")).toBe(s);
  });
});

describe("history controls", () => {
  test("restores bounded history without replaying active notifications", () => {
    const history: ToastHistoryEntry[] = Array.from(
      { length: MAX_TOAST_HISTORY + 2 },
      (_, index) => ({ ...mk(`saved-${index}`), createdAt: index, read: true }),
    );
    const state = initialToastState(history);
    expect(state.toasts).toEqual([]);
    expect(state.history).toHaveLength(MAX_TOAST_HISTORY);
    expect(state.history[0]!.id).toBe("saved-2");
    expect(history).toHaveLength(MAX_TOAST_HISTORY + 2);
  });

  test("marks existing history read while later notifications remain unread", () => {
    const state = addToast(initialToastState(), mk("a"), 100);
    const read = markToastHistoryRead(state);
    expect(read.history[0]!.read).toBe(true);
    expect(state.history[0]!.read).toBe(false);
    expect(read.toasts).toBe(state.toasts);
    expect(markToastHistoryRead(read)).toBe(read);
    const next = addToast(read, mk("b"), 200);
    expect(next.history.map((entry) => entry.read)).toEqual([true, false]);
  });

  test("clears history without dismissing active toasts", () => {
    const state = addToast(initialToastState(), mk("a"));
    const cleared = clearToastHistory(state);
    expect(cleared.history).toEqual([]);
    expect(cleared.toasts).toBe(state.toasts);
    expect(state.history).toHaveLength(1);
    expect(clearToastHistory(cleared)).toBe(cleared);
  });
});

describe("toastFromOptions", () => {
  test("fills defaults", () => {
    expect(toastFromOptions({ message: "hi" })).toEqual({
      message: "hi",
      variant: "default",
      durationMs: DEFAULT_TOAST_DURATION_MS,
    });
  });

  test("honours explicit variant and duration (including 0)", () => {
    expect(toastFromOptions({ message: "x", variant: "error", durationMs: 0 })).toEqual({
      message: "x",
      variant: "error",
      durationMs: 0,
    });
  });

  test("gives failures more reading time while preserving explicit duration", () => {
    expect(toastFromOptions({ message: "failure", variant: "error" }).durationMs).toBe(
      ERROR_TOAST_DURATION_MS,
    );
    expect(
      toastFromOptions({ message: "failure", variant: "error", durationMs: 1250 }).durationMs,
    ).toBe(1250);
  });

  test("retains optional diagnostic details without adding an absent key", () => {
    const detail = "command: example\nerror: a full diagnostic";
    expect(toastFromOptions({ message: "failed", detail }).detail).toBe(detail);
    expect(toastFromOptions({ message: "failed", detail: "" }).detail).toBe("");
    expect(toastFromOptions({ message: "failed" })).not.toHaveProperty("detail");
  });

  test("retains the originating session through history and dismissal", () => {
    const toast = {
      id: "background-failure",
      ...toastFromOptions({
        message: "后台命令失败",
        sessionId: "engine-session",
      }),
    };
    const state = dismissToast(addToast(initialToastState(), toast), toast.id);
    expect(state.toasts).toEqual([]);
    expect(state.history[0]!.sessionId).toBe("engine-session");
    expect(toastFromOptions({ message: "no session" })).not.toHaveProperty("sessionId");
    expect(toastFromOptions({ message: "empty", sessionId: "" })).not.toHaveProperty("sessionId");
  });
});
