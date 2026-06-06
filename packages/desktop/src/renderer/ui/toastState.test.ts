import { describe, expect, test } from "bun:test";
import {
  initialToastState,
  addToast,
  dismissToast,
  toastFromOptions,
  MAX_TOASTS,
  DEFAULT_TOAST_DURATION_MS,
  type Toast,
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
  });
});

describe("dismissToast", () => {
  test("removes by id", () => {
    let s = addToast(addToast(initialToastState(), mk("a")), mk("b"));
    s = dismissToast(s, "a");
    expect(s.toasts.map((t) => t.id)).toEqual(["b"]);
  });

  test("unknown id is a no-op returning the same reference", () => {
    const s = addToast(initialToastState(), mk("a"));
    expect(dismissToast(s, "zzz")).toBe(s);
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
});
