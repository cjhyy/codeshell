import { describe, test, expect } from "bun:test";
import { dayStamp, logPathForDay } from "./desktop-logger.js";

// Regression: logPath() cached the path once and never recomputed, so a
// long-running desktop process kept writing to the start-day's file after
// midnight (review-2026-05-30). The path is now derived from a per-call day
// stamp; these helpers pin that derivation.

describe("desktop log path is day-derived", () => {
  test("dayStamp formats YYYY-MM-DD with zero padding", () => {
    expect(dayStamp(new Date(2026, 0, 5))).toBe("2026-01-05"); // Jan 5
    expect(dayStamp(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  test("different days map to different log files", () => {
    const a = logPathForDay(dayStamp(new Date(2026, 4, 30)));
    const b = logPathForDay(dayStamp(new Date(2026, 4, 31)));
    expect(a).not.toBe(b);
    expect(a).toContain("desktop-2026-05-30.log");
    expect(b).toContain("desktop-2026-05-31.log");
  });
});

describe("desktop log root honors CODE_SHELL_HOME", () => {
  test("dlog writes under CODE_SHELL_HOME, never under HOME", async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { dlog, desktopLogDir } = await import("./desktop-logger.js");
    const prevHome = process.env.CODE_SHELL_HOME;
    const prevUserHome = process.env.HOME;
    const root = mkdtempSync(join(tmpdir(), "desktop-logger-home-"));
    const fakeUserHome = mkdtempSync(join(tmpdir(), "desktop-logger-userhome-"));
    process.env.CODE_SHELL_HOME = root;
    process.env.HOME = fakeUserHome;
    try {
      expect(desktopLogDir()).toBe(join(root, "logs", "desktop"));
      dlog("main", "logger-home-probe", { sid: "probe-sid" });
      const file = logPathForDay(dayStamp(new Date()));
      expect(file.startsWith(root)).toBe(true);
      for (
        let i = 0;
        i < 50 && !(existsSync(file) && readFileSync(file, "utf8").includes("logger-home-probe"));
        i++
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(readFileSync(file, "utf8")).toContain("logger-home-probe");
      expect(existsSync(join(fakeUserHome, ".code-shell"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prevHome;
      if (prevUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevUserHome;
      rmSync(fakeUserHome, { recursive: true, force: true });
      // streams stay open on a removed dir; harmless on POSIX
      rmSync(root, { recursive: true, force: true });
    }
  });
});
