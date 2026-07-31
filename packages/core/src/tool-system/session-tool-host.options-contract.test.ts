/**
 * A structural guard against one specific mistake that has now been made three
 * times on this options object:
 *
 *   round 1  permissionRules defaulted to `[]`      → user/preset rules dropped
 *   round 2  permissionRules made caller-supplied   → obligation nobody enforced
 *   round 3  projectTrusted optional, default true  → untrusted repo self-authorizes
 *
 * Every instance was the same shape: **a security-relevant input that is
 * optional, with a default that fails open.** Reviews caught all three, but a
 * review is a person remembering; this is the machine remembering.
 *
 * The rule: an input that decides what an untrusted external runtime may do is
 * REQUIRED. If a value must be chosen, the choice belongs to the caller who
 * knows the answer, made visibly, at the call site.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./session-tool-host.ts", import.meta.url), "utf8");

/**
 * Inputs where "not specified" must never silently resolve to the permissive
 * answer. Each entry names the failure it prevents so a future author who wants
 * to relax one has to argue with the reason, not just delete a line.
 */
const MUST_BE_REQUIRED: ReadonlyArray<{ field: string; because: string }> = [
  {
    field: "permissionMode",
    because: "decides whether the classifier consults rules at all",
  },
  {
    field: "presetRules",
    because: "an empty rule set silently downgrades every tool to the mode default",
  },
  {
    field: "projectTrusted",
    because: "defaulting to trusted lets a cloned repo self-authorize via settings",
  },
  {
    field: "planMode",
    because: "plan mode is a write barrier; defaulting it off widens the surface",
  },
  {
    field: "exposure",
    because: "without it there is no allowlist and nothing is narrowed",
  },
  {
    field: "visibility",
    because: "an absent toolVisibility makes ToolExecutor skip its availability guard",
  },
];

function optionsBlock(): string {
  const start = SOURCE.indexOf("export interface CreateSessionToolHostOptions");
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}", start);
  return SOURCE.slice(start, end);
}

describe("CreateSessionToolHostOptions contract", () => {
  test.each(MUST_BE_REQUIRED)("$field is required — $because", ({ field }) => {
    const block = optionsBlock();
    // Match the declaration, ignoring the doc comments above it.
    const declaration = new RegExp(`^\\s*${field}(\\??):`, "m").exec(block);
    expect(declaration).not.toBeNull();
    // Group 1 is "?" when optional. It must be empty.
    expect(declaration![1]).toBe("");
  });

  test("no security-relevant input acquires a fail-open default", () => {
    // A `?? true`, `?? []` or `!== false` on one of these inside the factory
    // would reintroduce the default that the required marker just removed.
    const factory = SOURCE.slice(SOURCE.indexOf("export function createSessionToolHost"));
    for (const { field } of MUST_BE_REQUIRED) {
      const fallback = new RegExp(`options\\.${field}\\s*(\\?\\?|\\|\\|)`).exec(factory);
      expect(fallback).toBeNull();
    }
  });
});
