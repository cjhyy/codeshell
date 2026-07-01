import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCacheDir } from "../llm/model-cache.js";
import { diagnostics } from "./diagnostics.js";
import { remoteTriggerTool } from "../tool-system/builtin/remote-trigger.js";

// BUG (homedir audit): model-cache / diagnostics / remote-trigger all built
// ~/.code-shell paths from raw homedir() (bun-cached at process start), so they
// ignored a runtime/test $HOME override and read/wrote the developer's REAL
// ~/.code-shell. userHome() (process.env.HOME ?? homedir()) fixes it. These pin
// that each honors a live $HOME.

let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "cs-homeiso-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("homedir isolation — model-cache / diagnostics / remote-trigger honor $HOME", () => {
  test("defaultCacheDir() resolves under $HOME", () => {
    expect(defaultCacheDir().startsWith(home)).toBe(true);
  });

  test("diagnostics.record persists under $HOME (singleton resolves per-write)", () => {
    diagnostics.record("info", "test", "isolation probe");
    expect(existsSync(join(home, ".code-shell", "diagnostics"))).toBe(true);
  });

  test("RemoteTrigger writes its trigger file under $HOME", async () => {
    const out = await remoteTriggerTool({ name: "probe", prompt: "do x" });
    expect(out).toContain("dispatched");
    // The tool reports "Stored at: <path>"; that path must be inside $HOME.
    expect(existsSync(join(home, ".code-shell", "triggers"))).toBe(true);
  });
});
