/**
 * A failed external-runtime turn has to reach the user's screen.
 *
 * This is a narrow contract with an outsized failure mode. `runExternalRuntimeTurn`
 * reports failure by RESOLVING with `{ok:false, reason:"external_runtime_error"}`
 * rather than throwing — deliberately, so the caller's shared `.then` chain still
 * clears busy. But the caller only renders an error for reasons on an explicit
 * allowlist, and a reason missing from that list produces the worst outcome
 * available: busy clears, no message, no toast, nothing in the transcript. The
 * user sees their prompt vanish.
 *
 * That is not hypothetical — it is what shipped. `external_runtime_error` was
 * absent from the allowlist, so "codex is not logged in" rendered as silence.
 * These tests pin both halves of the pairing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runExternalRuntimeTurn, resetExternalRuntimeSessions } from "./externalRuntimeRun.js";

const controllerSource = readFileSync(
  new URL("./app/useRunController.ts", import.meta.url),
  "utf8",
);

/** The `.then` handler on the MAIN send path (not the QuickChat one below it). */
function mainSendErrorBranch(): string {
  const start = controllerSource.indexOf("const startRun = externalRuntime");
  expect(start).toBeGreaterThan(-1);
  const end = controllerSource.indexOf("const sendQuickChat", start);
  return controllerSource.slice(start, end > start ? end : undefined);
}

describe("external runtime failures surface to the user", () => {
  test("the runner reports failure as a resolved result, not a throw", async () => {
    // Throwing would skip the caller's .then chain and leave the composer stuck
    // showing "running" forever — which is why this resolves instead.
    resetExternalRuntimeSessions();
    const result = await runExternalRuntimeTurn({
      sessionId: "sess-1",
      cwd: "/tmp/project",
      modelKey: "codex/gpt-5.6-sol",
      text: "hi",
      runtime: {
        start: () => Promise.reject(new Error("codex: not logged in")),
        send: () => Promise.reject(new Error("unreachable")),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("external_runtime_error");
    // The cause has to travel with it, or the toast says nothing actionable.
    expect(result.text).toMatch(/not logged in/);
  });

  test("the send path renders that reason instead of dropping it", () => {
    // The pairing: the runner can only be as useful as the branch that reads it.
    //
    // Matched as an actual COMPARISON, not a bare substring: the explanatory
    // comment beside this branch also names the reason, so `toContain` alone
    // stays green after the condition is deleted. Verified by mutation — the
    // substring form did exactly that.
    const branch = mainSendErrorBranch();
    expect(branch).toMatch(/reason === ["']external_runtime_error["']/);
    // It must reach BOTH surfaces — the transcript line and the toast. A toast
    // alone disappears; a transcript line alone is easy to miss mid-scroll.
    expect(branch).toContain('dispatch({ type: "turn_end"');
    expect(branch).toContain("toast(");
  });

  test("the reason list is a superset of the engine's original three", () => {
    // Guards the edit itself: appending to this condition must not drop the
    // pre-existing engine reasons, which have their own regression history
    // (the deepseek-vision rejection bug).
    const branch = mainSendErrorBranch();
    for (const reason of ["image_error", "model_error", "prompt_too_long"]) {
      expect(branch).toContain(reason);
    }
  });
});
