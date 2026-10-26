import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool, _setGrepExecFileForTest } from "./grep.js";
import type { ToolContext } from "../context.js";

let dir: string;
const ctx = () => ({ cwd: dir }) as unknown as ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(dir, "a.ts"), "const needle = 1;\nother line\n");
  writeFileSync(join(dir, "b.ts"), "no match here\n");
  writeFileSync(join(dir, "c.md"), "needle in markdown\n");
});
afterEach(() => {
  _setGrepExecFileForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("grepTool", () => {
  it("requires a pattern", async () => {
    expect(await grepTool({}, ctx())).toContain("pattern is required");
  });

  it("finds files containing the pattern (files_with_matches default)", async () => {
    const out = await grepTool({ pattern: "needle" }, ctx());
    // Whichever backend (rg/grep) ran, both matching files should appear.
    expect(out).toContain("a.ts");
    expect(out).toContain("c.md");
    expect(out).not.toContain("b.ts");
  });

  it("reports no matches clearly", async () => {
    const out = await grepTool({ pattern: "zzz-not-present-xyz" }, ctx());
    expect(out).toBe("No matches found.");
  });

  it("content mode shows the matching line", async () => {
    const out = await grepTool({ pattern: "needle", output_mode: "content" }, ctx());
    expect(out).toContain("const needle = 1;");
  });

  it("respects a file glob filter", async () => {
    const out = await grepTool({ pattern: "needle", glob: "*.md" }, ctx());
    expect(out).toContain("c.md");
    expect(out).not.toContain("a.ts");
  });

  it("ignores node_modules", async () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x.ts"), "needle here\n");
    const out = await grepTool({ pattern: "needle" }, ctx());
    expect(out).not.toContain("node_modules");
  });

  it("falls back to a built-in recursive search when rg and grep are unavailable", async () => {
    _setGrepExecFileForTest(async () => {
      const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const out = await grepTool({ pattern: "needle", glob: "*.ts", output_mode: "content" }, ctx());
    expect(out).toContain("a.ts:1:const needle = 1;");
    expect(out).not.toContain("c.md");
  });

  it("matches directory-qualified globs against the relative path in the built-in fallback", async () => {
    _setGrepExecFileForTest(async () => {
      const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, "src", "deep", "answer.ts"), "const needle = 42;\n");
    writeFileSync(join(dir, "src", "notes.md"), "needle notes\n");

    const scoped = await grepTool(
      { pattern: "needle", glob: "src/**/*.ts", output_mode: "content" },
      ctx(),
    );
    expect(scoped).toContain(`${join("src", "deep", "answer.ts")}:1:const needle = 42;`);
    expect(scoped).not.toContain("a.ts:");
    expect(scoped).not.toContain("notes.md");

    const braces = await grepTool({ pattern: "needle", glob: "*.{md,txt}" }, ctx());
    expect(braces).toContain("c.md");
    expect(braces).toContain("notes.md");
    expect(braces).not.toContain("a.ts");

    const negated = await grepTool({ pattern: "needle", glob: "!*.ts" }, ctx());
    expect(negated).toContain("c.md");
    expect(negated).not.toContain("answer.ts");
  });

  it("passes ctx.signal to the search process and stops fallback after abort", async () => {
    const controller = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];
    _setGrepExecFileForTest(async (_file, _args, options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      receivedSignals.push(signal);
      if (!signal) throw new Error("missing abort signal");
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    });

    const pending = grepTool({ pattern: "needle" }, { ...ctx(), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]?.aborted).toBe(true);
    expect(receivedSignals[0]?.reason).toBe(controller.signal.reason);
  });

  for (const code of ["ETIMEDOUT", "EACCES", 2]) {
    it(`preserves ripgrep failure ${code} instead of trying a different backend`, async () => {
      const error = Object.assign(new Error("ripgrep search failed"), { code });
      const calls: string[] = [];
      _setGrepExecFileForTest(async (file) => {
        calls.push(file);
        if (file === "rg") throw error;
        return { stdout: "unexpected fallback result", stderr: "" };
      });

      await expect(grepTool({ pattern: "needle" }, ctx())).rejects.toBe(error);
      expect(calls).toEqual(["rg"]);
    });
  }

  for (const code of ["ETIMEDOUT", "EACCES", 2]) {
    it(`does not start the Node scanner after grep failure ${code}`, async () => {
      const error = Object.assign(new Error("grep search failed"), { code });
      const calls: string[] = [];
      _setGrepExecFileForTest(async (file) => {
        calls.push(file);
        if (file === "rg") throw Object.assign(new Error("rg missing"), { code: "ENOENT" });
        throw error;
      });

      await expect(grepTool({ pattern: "needle" }, ctx())).rejects.toBe(error);
      expect(calls).toEqual(["rg", "grep"]);
    });
  }

  it("falls back to grep only when ripgrep is unavailable", async () => {
    const calls: string[] = [];
    _setGrepExecFileForTest(async (file) => {
      calls.push(file);
      if (file === "rg") throw Object.assign(new Error("rg missing"), { code: "ENOENT" });
      return { stdout: `${join(dir, "a.ts")}\n`, stderr: "" };
    });

    expect(await grepTool({ pattern: "needle" }, ctx())).toBe("a.ts");
    expect(calls).toEqual(["rg", "grep"]);
  });

  it("uses the remaining overall timeout when switching search backends", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    _setGrepExecFileForTest(async (file, _args, options) => {
      timeouts.push(options.timeout);
      if (file === "rg") {
        now += 10_000;
        throw Object.assign(new Error("rg missing"), { code: "ENOENT" });
      }
      return { stdout: "a.ts\n", stderr: "" };
    });
    try {
      expect(await grepTool({ pattern: "needle" }, ctx())).toBe("a.ts");
      expect(timeouts).toEqual([30_000, 20_000]);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not begin the Node fallback after the overall deadline", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    _setGrepExecFileForTest(async () => {
      now += 20_000;
      throw Object.assign(new Error("search executable missing"), { code: "ENOENT" });
    });
    try {
      await expect(grepTool({ pattern: "needle" }, ctx())).rejects.toMatchObject({
        code: "ETIMEDOUT",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("checks the shared deadline while traversing the Node fallback", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    _setGrepExecFileForTest(async () => {
      throw Object.assign(new Error("search executable missing"), { code: "ENOENT" });
    });
    const originalReaddir = fsPromises.readdir;
    const readDirectory = spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      const entries = await (originalReaddir as any)(...args);
      now += 31_000;
      return entries;
    });
    try {
      await expect(grepTool({ pattern: "needle" }, ctx())).rejects.toMatchObject({
        code: "ETIMEDOUT",
      });
    } finally {
      clock.mockRestore();
      readDirectory.mockRestore();
    }
  });

  it("does not swallow cancellation during a Node fallback file read", async () => {
    const controller = new AbortController();
    _setGrepExecFileForTest(async () => {
      throw Object.assign(new Error("search executable missing"), { code: "ENOENT" });
    });
    const read = spyOn(fsPromises, "readFile").mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    try {
      await expect(
        grepTool({ pattern: "needle" }, { ...ctx(), signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      read.mockRestore();
    }
  });

  it("stops walking directories once the Node fallback has enough results", async () => {
    _setGrepExecFileForTest(async () => {
      throw Object.assign(new Error("search executable missing"), { code: "ENOENT" });
    });
    mkdirSync(join(dir, "z-later"));
    writeFileSync(join(dir, "z-later", "late.ts"), "needle later\n");
    const originalReaddir = fsPromises.readdir;
    const readDirectory = spyOn(fsPromises, "readdir").mockImplementation(async (...args) => {
      const entries = await (originalReaddir as any)(...args);
      return entries.sort((a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name),
      );
    });
    try {
      expect(await grepTool({ pattern: "needle", max_results: 1 }, ctx())).toBe("a.ts");
      expect(readDirectory.mock.calls.map(([path]) => path)).toEqual([dir]);
    } finally {
      readDirectory.mockRestore();
    }
  });
});
