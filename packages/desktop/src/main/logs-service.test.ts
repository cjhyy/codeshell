import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logPathForDay } from "./desktop-logger";
import { tailLog } from "./logs-service";

describe("tailLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-logs-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLog(relativeFile: string, text: string, mtime = 1_000): void {
    const file = path.join(dir, relativeFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, mtime, mtime);
  }

  it("reads the desktop writer's directory and returns only the requested recent lines", async () => {
    const writerRelativePath = path.relative(
      path.join(os.homedir(), ".code-shell", "logs"),
      logPathForDay("2026-09-07"),
    );
    writeLog(writerRelativePath, "boot\n\nrequest\ncomplete\n");

    expect(await tailLog("desktop", 2, dir)).toEqual(["request", "complete"]);
  });

  it("keeps engine and terminal buckets separate in the top-level directory", async () => {
    writeLog("engine-2026-09-07.log", "engine\n");
    writeLog("ui-ink-2026-09-07.log", "terminal\n");
    writeLog("desktop/desktop-2026-09-07.log", "desktop\n");

    expect(await tailLog("engine", 200, dir)).toEqual(["engine"]);
    expect(await tailLog("ui-ink", 200, dir)).toEqual(["terminal"]);
  });

  it("reads legacy flat desktop logs when the dedicated directory is absent", async () => {
    writeLog("desktop-2026-09-06.log", "legacy\n");

    expect(await tailLog("desktop", 200, dir)).toEqual(["legacy"]);
  });

  it("selects the newest desktop log across old and current locations", async () => {
    writeLog("desktop-2026-09-05.log", "legacy\n", 1_000);
    writeLog("desktop/desktop-2026-09-06.log", "yesterday\n", 2_000);
    writeLog("desktop/desktop-2026-09-07.log", "today\n", 3_000);
    writeLog("desktop/engine-2026-09-07.log", "wrong bucket\n", 4_000);
    writeLog("desktop/desktop-2026-09-07.jsonl", "wrong extension\n", 5_000);

    expect(await tailLog("desktop", 200, dir)).toEqual(["today"]);
  });

  it("returns no lines when the log directory or selected bucket is absent", async () => {
    expect(await tailLog("desktop", 200, path.join(dir, "missing"))).toEqual([]);
    expect(await tailLog("engine", 200, dir)).toEqual([]);
  });
});
