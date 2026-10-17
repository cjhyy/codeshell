import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import children from "node:child_process";
import type { ToolContext } from "../../../../core/src/tool-system/context";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { Message } from "../types";
import { aggregateFileChangeSummary } from "../messages/fileChangeAggregator";
import { composeFileEdits, type FileEditOperation } from "./composeFileEdits";
import { parseUnifiedDiff } from "./parseUnifiedDiff";

// This experiment executes only the real Edit leaf against an owned file. The
// broker/ToolExecutor approval path, Engine, providers and hooks are not entered.
// Install denial before the dynamic Core leaf import; no origin is allowed.
const attempts: string[] = [];
const restore: Array<() => void> = [];
function deny(kind: string): never {
  attempts.push(kind);
  throw new Error(`Owned snippet experiment denied ${kind}`);
}
function replace(object: any, key: string, value: unknown) {
  const previous = object[key];
  object[key] = value;
  restore.push(() => (object[key] = previous));
}
replace(globalThis, "fetch", () => deny("fetch"));
for (const [object, keys, kind] of [
  [http, ["get", "request"], "http"],
  [https, ["get", "request"], "https"],
  [net, ["connect", "createConnection"], "socket"],
  [tls, ["connect"], "tls"],
  [
    children,
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    "process",
  ],
] as const)
  for (const key of keys) replace(object, key, () => deny(kind));
syncBuiltinESMExports();
// These synchronous negative probes cannot create a connection or process.
for (const probe of [
  () => fetch("https://example.invalid/denied"),
  () => http.request("http://127.0.0.1:9/denied"),
  () => https.get("https://example.invalid/denied"),
  () => net.connect(9, "127.0.0.1"),
  () => tls.connect(443, "example.invalid"),
  () => children.spawn("owned-denied-executable", []),
]) {
  let refused = false;
  try {
    probe();
  } catch (error) {
    refused =
      error instanceof Error && error.message.startsWith("Owned snippet experiment denied ");
  }
  if (!refused) throw Error("Snippet experiment guard probe escaped");
}
const guardProbeCount = attempts.length;
attempts.length = 0;

const { editTool } = await import("../../../../core/src/tool-system/builtin/edit");
const { INITIAL_STATE, applyStreamEvent } = await import("../types");
const args = [
  { file_path: "sample.ts", old_string: "before();", new_string: "shared();" },
  {
    file_path: "sample.ts",
    old_string: "// later\nshared();",
    new_string: "// later\nfinal();",
  },
];
const operations: FileEditOperation[] = args.map(({ old_string, new_string }) => ({
  kind: "edit",
  oldText: old_string,
  newText: new_string,
}));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function changes(diff: string): string[] {
  return parseUnifiedDiff(diff).flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind === "add" || line.kind === "del")
        .map((line) => `${line.kind === "add" ? "+" : "-"}${line.text}`),
    ),
  );
}

let root: string;
const cases = [
  {
    name: "different-locations",
    initial: "before();\n// later\nshared();\n",
    expected: "shared();\n// later\nfinal();\n",
    results: [] as string[],
    uniqueness: [] as Array<{ first: number; last: number }>,
  },
  {
    name: "same-location-control",
    initial: "// later\nbefore();\n",
    expected: "// later\nfinal();\n",
    results: [] as string[],
    uniqueness: [] as Array<{ first: number; last: number }>,
  },
];
beforeAll(async () => {
  expect(guardProbeCount).toBe(6);
  expect(attempts).toEqual([]);
  root = mkdtempSync(join(process.env.HOME!, "owned-snippet-containment-"));
  for (const scenario of cases) {
    const cwd = join(root, scenario.name);
    mkdirSync(cwd, { mode: 0o700 });
    const path = join(cwd, "sample.ts");
    writeFileSync(path, scenario.initial, { mode: 0o600 });
    const context = new Proxy(
      { cwd, workspace: undefined },
      {
        get(target, key) {
          if (key !== "cwd" && key !== "workspace")
            throw Error(`Unexpected Edit leaf service: ${String(key)}`);
          return target[key];
        },
      },
    ) as unknown as ToolContext;
    for (const input of args) {
      const before = readFileSync(path, "utf8");
      const first = before.indexOf(input.old_string),
        last = before.lastIndexOf(input.old_string);
      scenario.uniqueness.push({ first, last });
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBe(last); // actual global uniqueness, not snippet-only uniqueness
      const result = await editTool({ ...input }, context);
      expect(typeof result).toBe("string");
      expect(result).toContain("1 replacement");
      scenario.results.push(result as string);
    }
    const actual = readFileSync(path, "utf8");
    expect(actual).toBe(scenario.expected);
    const summary = aggregateFileChangeSummary(messages(scenario.results));
    console.log(
      JSON.stringify({
        scenario: scenario.name,
        boundary:
          "Real Core Edit leaf and owned bytes; no ToolExecutor/Engine/provider/approval chain",
        args,
        initial: scenario.initial,
        actual,
        initialSHA256: sha256(scenario.initial),
        finalSHA256: sha256(actual),
        uniqueness: scenario.uniqueness,
        results: scenario.results,
        summary,
        composed: composeFileEdits("sample.ts", operations),
        guardProbeCount,
        actualNetworkOrProcessAttempts: attempts,
      }),
    );
  }
  expect(attempts).toEqual([]);
});
afterAll(() => {
  try {
    expect(attempts).toEqual([]);
    if (root) rmSync(root, { recursive: true });
  } finally {
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
  }
});
function messages(results: string[]): Message[] {
  return [
    { kind: "user", id: "owned-user", text: "Edit owned file" },
    ...args.map((input, index) => ({
      kind: "tool" as const,
      id: `owned-edit-${index}`,
      toolName: "Edit",
      args: JSON.stringify(input),
      result: results[index],
      status: "succeeded" as const,
      startedAt: index,
    })),
  ];
}

test("actual globally unique Core edits yield different files for identical snippet operations", () => {
  expect(cases[0]!.uniqueness).toEqual([
    { first: 0, last: 0 },
    { first: 10, last: 10 },
  ]);
  expect(cases[1]!.uniqueness).toEqual([
    { first: 9, last: 9 },
    { first: 0, last: 0 },
  ]);
  expect(cases[0]!.expected).not.toBe(cases[1]!.expected);
});

test("same-location control currently composes a valid net preview from the same payloads", () => {
  const summary = aggregateFileChangeSummary(messages(cases[1]!.results))!;
  expect(changes(summary.sessionDiffs[0]!.diff)).toEqual(["-before();", "+final();"]);
  expect(summary.files).toEqual([{ path: "sample.ts", added: 1, removed: 1, count: 2 }]);
});

test("different-location aggregation must preserve the independently added first shared line", () => {
  const summary = aggregateFileChangeSummary(messages(cases[0]!.results))!;
  const changed = changes(summary.sessionDiffs[0]!.diff);
  expect(changed).toContain("+shared();");
  expect(changed).toContain("+final();");
});

test("actual renderer completion must not hide the first independent Edit in its Review snapshot", () => {
  const state = applyStreamEvent({ ...INITIAL_STATE, messages: messages(cases[0]!.results) }, {
    type: "turn_complete",
    reason: "completed",
  } as StreamEvent);
  const card = state.messages.find((message) => message.kind === "files_changed");
  expect(card?.kind).toBe("files_changed");
  if (card?.kind !== "files_changed") throw Error("Missing actual completion card");
  expect(changes(card.sessionDiffs![0]!.diff)).toContain("+shared();");
});
