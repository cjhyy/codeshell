import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { rememberOwnedProcesses } from "./process-custody.mjs";

test("a reused root PID cannot authorize its new process or descendants", () => {
  const original = { pid: 10, ppid: 1, birth: "Sat Oct 17 13:40:00 2026" };
  const owned = new Map([[10, original]]);
  rememberOwnedProcesses(owned, [
    { pid: 10, ppid: 1, birth: "Sat Oct 17 13:50:00 2026" },
    { pid: 11, ppid: 10, birth: "Sat Oct 17 13:51:00 2026" },
  ]);
  deepStrictEqual([...owned.values()], [original]);
});

test("a live owned descendant remains a valid root after its original parent exits", () => {
  const original = { pid: 10, ppid: 1, birth: "Sat Oct 17 13:40:00 2026" };
  const child = { pid: 11, ppid: 10, birth: "Sat Oct 17 13:41:00 2026" };
  const grandchild = { pid: 12, ppid: 11, birth: "Sat Oct 17 13:42:00 2026" };
  const owned = new Map([
    [10, original],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [
    { pid: 10, ppid: 1, birth: "Sat Oct 17 13:50:00 2026" },
    { ...child, ppid: 1 },
    grandchild,
  ]);
  deepStrictEqual([...owned.values()], [original, child, grandchild]);
});

test("a reused descendant PID cannot overwrite its prior identity or authorize another child", () => {
  const original = { pid: 10, ppid: 1, birth: "Sat Oct 17 13:40:00 2026" };
  const child = { pid: 11, ppid: 10, birth: "Sat Oct 17 13:41:00 2026" };
  const owned = new Map([
    [10, original],
    [11, child],
  ]);
  rememberOwnedProcesses(owned, [
    original,
    { pid: 11, ppid: 10, birth: "Sat Oct 17 13:51:00 2026" },
    { pid: 12, ppid: 11, birth: "Sat Oct 17 13:52:00 2026" },
  ]);
  deepStrictEqual([...owned.values()], [original, child]);
});
