import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadToastHistory,
  saveToastHistory,
  TOAST_HISTORY_STORAGE_KEY,
} from "./toastHistoryStorage";
import { MAX_TOAST_HISTORY, type ToastHistoryEntry } from "./toastState";

const entry = (id = "failure"): ToastHistoryEntry => ({
  id,
  message: "保存失败\n完整错误信息",
  detail: "command: bun run build\ncwd: /project\nerror: detailed failure",
  variant: "error",
  durationMs: 8000,
  createdAt: 1_700_000_000_000,
  read: false,
});

let previousStorage: PropertyDescriptor | undefined;
let values: Map<string, string>;

beforeEach(() => {
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  values = new Map();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("window-local toast history", () => {
  test("round trips complete messages, details, timestamps, and read state", () => {
    const original = {
      ...entry(),
      message: "日志失败\n" + "完整的错误文字".repeat(1000),
      detail: "完整的命令输出\n".repeat(1500),
      read: true,
    };
    saveToastHistory([original]);
    expect(values.has(TOAST_HISTORY_STORAGE_KEY)).toBe(true);
    expect(loadToastHistory()).toEqual([original]);
  });

  test("ignores malformed JSON and non-array values", () => {
    expect(loadToastHistory()).toEqual([]);
    for (const raw of ["{broken", "null", '"history"', "42", "{}"] as const) {
      values.set(TOAST_HISTORY_STORAGE_KEY, raw);
      expect(loadToastHistory()).toEqual([]);
    }
  });

  test("validates every required field and optional details before restoring", () => {
    const valid = entry("valid");
    const invalid = [
      null,
      [],
      "message",
      {},
      { ...valid, id: "" },
      { ...valid, id: 12 },
      { ...valid, message: null },
      { ...valid, detail: {} },
      { ...valid, variant: "warning" },
      { ...valid, durationMs: -1 },
      { ...valid, durationMs: "8000" },
      { ...valid, durationMs: null },
      { ...valid, createdAt: -1 },
      { ...valid, createdAt: 1e30 },
      { ...valid, createdAt: "yesterday" },
      { ...valid, read: "false" },
      { ...valid, read: undefined },
    ];
    const withoutDetail = { ...entry("without-detail") };
    delete withoutDetail.detail;
    values.set(TOAST_HISTORY_STORAGE_KEY, JSON.stringify([valid, ...invalid, withoutDetail]));
    expect(loadToastHistory()).toEqual([valid, withoutDetail]);
  });

  test("limits restored and saved history to the newest entries", () => {
    const history = Array.from({ length: MAX_TOAST_HISTORY + 4 }, (_, index) => entry(`t${index}`));
    values.set(TOAST_HISTORY_STORAGE_KEY, JSON.stringify(history));
    expect(loadToastHistory()).toEqual(history.slice(-MAX_TOAST_HISTORY));
    saveToastHistory(history);
    expect(JSON.parse(values.get(TOAST_HISTORY_STORAGE_KEY)!)).toEqual(
      history.slice(-MAX_TOAST_HISTORY),
    );
    expect(history).toHaveLength(MAX_TOAST_HISTORY + 4);
  });

  test("saving empty history removes previous records on reload", () => {
    saveToastHistory([entry()]);
    saveToastHistory([]);
    expect(loadToastHistory()).toEqual([]);
  });

  test("storage failures never throw or mutate the caller's in-memory history", () => {
    const history = [entry()];
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("read unavailable");
        },
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    });
    expect(loadToastHistory()).toEqual([]);
    expect(() => saveToastHistory(history)).not.toThrow();
    expect(history).toEqual([entry()]);
  });

  test("unavailable or blocked session storage is optional", () => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
    expect(loadToastHistory()).toEqual([]);
    expect(() => saveToastHistory([entry()])).not.toThrow();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage access denied");
      },
    });
    expect(loadToastHistory()).toEqual([]);
    expect(() => saveToastHistory([entry()])).not.toThrow();
  });
});
