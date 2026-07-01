import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSession } from "./auto-dream.js";

// BUG (homedir audit): auto-dream state used raw homedir(), ignoring both
// CODE_SHELL_HOME and $HOME. Every session end wrote auto-dream-state.json to
// the REAL ~/.code-shell — polluting the developer's disk on every test run and
// desyncing cadence when a host relocates HOME/CODE_SHELL_HOME. State must live
// under the same base as memories (resolveMemoryBaseDir).

let prevCsHome: string | undefined;
let csHome: string;

beforeEach(() => {
  prevCsHome = process.env.CODE_SHELL_HOME;
  csHome = mkdtempSync(join(tmpdir(), "cs-autodream-"));
  process.env.CODE_SHELL_HOME = csHome;
});

afterEach(() => {
  if (prevCsHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevCsHome;
  rmSync(csHome, { recursive: true, force: true });
});

describe("auto-dream state honors CODE_SHELL_HOME (no real-disk pollution)", () => {
  test("recordSession writes state under CODE_SHELL_HOME, not the real home", () => {
    recordSession();
    // The state file must land inside the isolated home.
    expect(existsSync(join(csHome, "auto-dream-state.json"))).toBe(true);
  });
});
