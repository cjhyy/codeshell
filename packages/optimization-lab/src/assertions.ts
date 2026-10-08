import type { HardAssertion } from "./contracts/eval-case.js";

export interface AssertionResult {
  id: string;
  passed: boolean;
  reason: string;
}

const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Deliberately not JSONPath: only bounded own-property traversal is supported. */
export function evaluateAssertions(output: string, assertions: HardAssertion[]): AssertionResult[] {
  return assertions.map((assertion) => {
    if (assertion.kind === "contains") {
      const passed = output.includes(assertion.value);
      return { id: assertion.id, passed, reason: passed ? "contains" : "required text missing" };
    }
    if (assertion.kind === "not_contains") {
      const passed = !output.includes(assertion.value);
      return {
        id: assertion.id,
        passed,
        reason: passed ? "excluded text absent" : "excluded text found",
      };
    }
    if (assertion.path.some((part) => forbidden.has(part) || !/^[a-zA-Z0-9_-]+$/.test(part))) {
      return { id: assertion.id, passed: false, reason: "unsupported JSON property path" };
    }
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      return { id: assertion.id, passed: false, reason: "output is not valid JSON" };
    }
    for (const part of assertion.path) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
        return { id: assertion.id, passed: false, reason: "JSON property is missing" };
      }
      value = (value as Record<string, unknown>)[part];
    }
    const passed = Object.is(value, assertion.value);
    return {
      id: assertion.id,
      passed,
      reason: passed ? "JSON value matches" : "JSON value differs",
    };
  });
}
