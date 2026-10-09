import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { rememberOwnedProcesses } from "./process-custody.mjs";

test("a reused root PID cannot authorize its new process or descendants", () => {
  const original = { pid: 10, ppid: 1, birth: "original" };
  const owned = new Map([[10, original]]);
  rememberOwnedProcesses(owned, [
    { pid: 10, ppid: 1, birth: "reused" },
    { pid: 11, ppid: 10, birth: "unrelated child" },
  ]);
  deepStrictEqual([...owned.values()], [original]);
});

test("a live owned descendant remains a valid root after its original parent exits", () => {
  const original = { pid: 10, ppid: 1, birth: "original" };
  const child = { pid: 11, ppid: 10, birth: "child" };
  const grandchild = { pid: 12, ppid: 11, birth: "new child" };
  const owned = new Map([
    [10, original],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [
    { pid: 10, ppid: 1, birth: "reused" },
    { ...child, ppid: 1 },
    grandchild,
  ]);
  deepStrictEqual([...owned.values()], [original, child, grandchild]);
});

test("a reused descendant PID cannot overwrite its prior identity or authorize another child", () => {
  const original = { pid: 10, ppid: 1, birth: "original" };
  const child = { pid: 11, ppid: 10, birth: "old child" };
  const owned = new Map([
    [10, original],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [
    original,
    { pid: 11, ppid: 10, birth: "reused child" },
    { pid: 12, ppid: 11, birth: "unrelated grandchild" },
  ]);
  deepStrictEqual([...owned.values()], [original, child]);
});
