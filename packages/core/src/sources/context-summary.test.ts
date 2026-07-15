import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../settings/manager.js";
import { bindSource } from "./binding.js";
import { saveSourceDefinition } from "./catalog.js";
import { buildSourcesContextSummary } from "./context-summary.js";

let home: string;
let cwd: string;
let previousCodeShellHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-context-"));
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

describe("buildSourcesContextSummary", () => {
  test("returns an empty string when the workspace has no bound sources", () => {
    const settings = new SettingsManager(cwd, "full");

    expect(buildSourcesContextSummary({ cwd, settings })).toBe("");
  });

  test("includes only bound-source metadata, never adapter secrets or resource content", () => {
    const settings = new SettingsManager(cwd, "full");
    saveSourceDefinition({
      id: "research",
      kind: "mock",
      label: "Research Library",
      adapterConfig: {
        token: "adapter-secret",
        resourceContent: "private resource body",
      },
      credentialRef: "credential-secret-ref",
      enabled: true,
    });
    bindSource(settings, cwd, {
      sourceId: "research",
      scopes: ["reports", "briefs"],
      readPolicy: "ask",
    });

    const summary = buildSourcesContextSummary({
      cwd,
      settings,
      credentialStatus: () => "ok",
    });

    expect(summary).toContain("Research Library");
    expect(summary).toContain("mock");
    expect(summary).toContain("ok");
    expect(summary).toContain("reports, briefs");
    expect(summary).not.toContain("adapter-secret");
    expect(summary).not.toContain("private resource body");
    expect(summary).not.toContain("credential-secret-ref");
  });
});
