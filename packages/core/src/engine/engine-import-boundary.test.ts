import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

describe("engine import boundaries", () => {
  it("keeps tool-system production modules independent of engine/engine", async () => {
    const root = join(import.meta.dir, "..", "tool-system");
    const offenders: string[] = [];
    for await (const relative of new Glob("**/*.ts").scan({ cwd: root })) {
      if (relative.endsWith(".test.ts")) continue;
      const source = readFileSync(join(root, relative), "utf8");
      if (/from\s+["'][^"']*engine\/engine(?:\.js)?["']/u.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps extracted engine modules from importing the facade", async () => {
    const offenders: string[] = [];
    for await (const relative of new Glob("*.ts").scan({ cwd: import.meta.dir })) {
      if (relative === "engine.ts" || relative.endsWith(".test.ts")) continue;
      const source = readFileSync(join(import.meta.dir, relative), "utf8");
      if (/from\s+["']\.\/engine(?:\.js)?["']/u.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
