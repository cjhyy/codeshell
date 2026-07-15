import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager, createToolRegistryHarness } from "../index.js";
import { bindSource, saveSourceDefinition, unbindSource } from "../index.internal.js";
import type { ToolResult } from "../types.js";

const previousCodeShellHome = process.env.CODE_SHELL_HOME;
let tempRoot: string | undefined;

afterEach(() => {
  if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousCodeShellHome;

  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function successfulText(result: ToolResult): string {
  expect(result.isError).toBe(false);
  expect(result.result).toBeString();
  return result.result as string;
}

function errorText(result: ToolResult): string {
  expect(result.isError).toBe(true);
  expect(result.error).toBeString();
  return result.error as string;
}

describe("mock source vertical e2e through ToolRegistry", () => {
  test("binds, lists, reads, re-authorizes, unbinds, and enforces unavailable/deny", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "cs-source-e2e-"));
    const cwd = join(tempRoot, "workspace");
    mkdirSync(cwd, { recursive: true });
    process.env.CODE_SHELL_HOME = join(tempRoot, "code-shell-home");

    saveSourceDefinition({
      id: "m1",
      kind: "mock",
      label: "Mock One",
      adapterConfig: {},
      enabled: true,
    });

    const settings = new SettingsManager(cwd, "full");
    const harness = createToolRegistryHarness({
      cwd,
      builtinTools: ["ListSources", "ReadSource"],
    });

    expect(harness.registry.getTool("ReadSource")?.permissionDefault).toBe("ask");

    bindSource(settings, cwd, {
      sourceId: "m1",
      scopes: ["alpha"],
      readPolicy: "ask",
    });

    const boundList = successfulText(await harness.execute("ListSources"));
    expect(boundList).toContain("Mock One");
    expect(boundList).toContain("id: m1");
    expect(boundList).toContain("scope: alpha");
    expect(boundList).toContain("resource: alpha/doc-1");
    expect(boundList).not.toContain("alpha doc one 内容");
    expect(boundList).not.toContain("alpha doc two content");

    const allowedRead = successfulText(
      await harness.execute("ReadSource", {
        source: "m1",
        scope: "alpha",
        resource: "alpha/doc-1",
      }),
    );
    expect(allowedRead).toContain("alpha doc one 内容");
    expect(allowedRead).toContain("source=m1");
    expect(allowedRead).toContain("scope=alpha");
    expect(allowedRead).toContain("resource=alpha/doc-1");
    expect(allowedRead).toMatch(/untrusted/i);

    const unboundScopeRead = errorText(
      await harness.execute("ReadSource", {
        source: "m1",
        scope: "beta",
        resource: "beta/note-1",
      }),
    );
    expect(unboundScopeRead).toMatch(/^Error:/);
    expect(unboundScopeRead).toContain('scope "beta" is not bound');
    expect(unboundScopeRead).not.toContain("beta note one content");

    unbindSource(settings, cwd, "m1");

    const unboundList = successfulText(await harness.execute("ListSources"));
    expect(unboundList).not.toContain("m1");
    expect(unboundList).toContain("No data sources are bound");

    const unboundRead = errorText(
      await harness.execute("ReadSource", {
        source: "m1",
        scope: "alpha",
        resource: "alpha/doc-1",
      }),
    );
    expect(unboundRead).toMatch(/^Error:/);
    expect(unboundRead).toContain('source "m1" is not bound');

    saveSourceDefinition({
      id: "m1",
      kind: "mock",
      label: "Mock One",
      adapterConfig: {},
      enabled: false,
    });
    bindSource(settings, cwd, {
      sourceId: "m1",
      scopes: ["alpha"],
      readPolicy: "ask",
    });

    const unavailableList = successfulText(await harness.execute("ListSources"));
    expect(unavailableList).toContain("id: m1");
    expect(unavailableList).toContain("status: unavailable");

    const unavailableRead = errorText(
      await harness.execute("ReadSource", {
        source: "m1",
        scope: "alpha",
        resource: "alpha/doc-1",
      }),
    );
    expect(unavailableRead).toMatch(/^Error:/);
    expect(unavailableRead).toContain('source "m1" is unavailable');

    saveSourceDefinition({
      id: "m1",
      kind: "mock",
      label: "Mock One",
      adapterConfig: {},
      enabled: true,
    });
    bindSource(settings, cwd, {
      sourceId: "m1",
      scopes: ["alpha"],
      readPolicy: "deny",
    });

    const deniedList = successfulText(await harness.execute("ListSources"));
    expect(deniedList).toContain("id: m1");
    expect(deniedList).toContain("status: ok");
    expect(deniedList).toContain("readPolicy: deny");
    expect(deniedList).toContain("resource: alpha/doc-1");
    expect(deniedList).not.toContain("alpha doc one 内容");

    const deniedRead = errorText(
      await harness.execute("ReadSource", {
        source: "m1",
        scope: "alpha",
        resource: "alpha/doc-1",
      }),
    );
    expect(deniedRead).toMatch(/^Error:/);
    expect(deniedRead).toContain("metadata-only");
    expect(deniedRead).toContain("readPolicy: deny");
  });
});
