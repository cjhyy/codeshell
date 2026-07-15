import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { bindSource, listBindings, unbindSource } from "./binding.js";

let home: string;
let cwd: string;
let previousCodeShellHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-source-binding-"));
  cwd = join(home, "workspace");
  mkdirSync(cwd, { recursive: true });
  previousCodeShellHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
});

afterEach(() => {
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;
  rmSync(home, { recursive: true, force: true });
});

describe("workspace source binding", () => {
  test("rebinding the same source replaces scopes and policy without duplicating it", () => {
    const settings = new SettingsManager(cwd, "full");
    bindSource(settings, cwd, { sourceId: "research", scopes: ["alpha"], readPolicy: "ask" });
    bindSource(settings, cwd, {
      sourceId: "research",
      scopes: ["beta", "gamma"],
      readPolicy: "deny",
    });

    expect(listBindings(settings, cwd)).toEqual([
      { sourceId: "research", scopes: ["beta", "gamma"], readPolicy: "deny" },
    ]);
  });

  test("unbind removes the selected source and preserves other bindings", () => {
    const settings = new SettingsManager(cwd, "full");
    bindSource(settings, cwd, { sourceId: "research", scopes: ["alpha"], readPolicy: "ask" });
    bindSource(settings, cwd, { sourceId: "docs", scopes: ["public"], readPolicy: "deny" });

    unbindSource(settings, cwd, "research");

    expect(listBindings(settings, cwd)).toEqual([
      { sourceId: "docs", scopes: ["public"], readPolicy: "deny" },
    ]);
  });
});
