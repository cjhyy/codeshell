import { describe, test, expect } from "bun:test";
import { HookRegistry } from "./registry.js";

// Regression for the file_history_backup leak: a handler that is re-registered
// every run() MUST be unregisterable by identity so it doesn't stack across
// runs. This pins the registry contract the engine fix relies on:
//   - unregister removes by handler identity (not by name)
//   - the same name registered with a FRESH closure each "run" only leaves one
//     handler when each run unregisters its own closure in finally.

describe("HookRegistry unregister-by-identity (file_history_backup leak)", () => {
  test("a named handler re-registered per run does not accumulate when each run unregisters its own", () => {
    const reg = new HookRegistry();

    // Simulate three engine.run() calls. Each makes a FRESH closure (as the
    // engine does — the handler closes over per-run session/fileHistory), and
    // unregisters that exact closure in its finally.
    for (let run = 0; run < 3; run++) {
      const handler = async () => ({});
      reg.register("on_tool_start", handler, 100, "file_history_backup");
      expect(reg.countHandlers("on_tool_start")).toBe(1);
      // ...run body would execute here...
      reg.unregister("on_tool_start", handler);
      expect(reg.countHandlers("on_tool_start")).toBe(0);
    }

    // No leak: the event is fully drained after the last run.
    expect(reg.countHandlers("on_tool_start")).toBe(0);
    expect(reg.listHooks().has("on_tool_start")).toBe(false);
  });

  test("WITHOUT unregistering, identical-name handlers DO stack (this is the bug being prevented)", () => {
    const reg = new HookRegistry();
    for (let run = 0; run < 3; run++) {
      reg.register("on_tool_start", async () => ({}), 100, "file_history_backup");
    }
    // Three distinct closures under the same name — the pre-fix leak.
    expect(reg.countHandlers("on_tool_start")).toBe(3);
    expect(reg.listHooks().get("on_tool_start")).toEqual([
      "file_history_backup",
      "file_history_backup",
      "file_history_backup",
    ]);
  });

  test("unregister matches by identity, so a different closure with the same name is NOT removed", () => {
    const reg = new HookRegistry();
    const a = async () => ({});
    const b = async () => ({});
    reg.register("on_tool_start", a, 100, "file_history_backup");
    reg.register("on_tool_start", b, 100, "file_history_backup");
    reg.unregister("on_tool_start", a);
    // b survives — identity, not name, governs removal. (Confirms why the engine
    // MUST keep a reference to its own closure to clean up correctly.)
    expect(reg.countHandlers("on_tool_start")).toBe(1);
  });
});
