import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "../../settings/manager.js";
import {
  connectorAdapterFor,
  registerConnectorAdapter,
  type ConnectorAdapter,
} from "../../sources/adapter.js";
import { localFilesAdapter } from "../../sources/adapters/local-files.js";
import { mockAdapter } from "../../sources/adapters/mock.js";
import { bindSource } from "../../sources/binding.js";
import { saveSourceDefinition } from "../../sources/catalog.js";
import type { ToolContext } from "../context.js";
import { BUILTIN_TOOLS } from "./index.js";
import { listSourcesTool, readSourceTool, registerBuiltinSourceAdapters } from "./sources.js";

let home: string;
let cwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-src-tools-"));
  cwd = join(home, "ws");
  mkdirSync(join(cwd, ".code-shell", "uploads"), { recursive: true });
  writeFileSync(join(cwd, ".code-shell", "uploads", "brief.md"), "brief body");
  prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = home;
  saveSourceDefinition({
    id: "m1",
    kind: "mock",
    label: "Mock1",
    adapterConfig: {},
    enabled: true,
  });
  const sm = new SettingsManager(cwd, "full");
  bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
});

afterEach(() => {
  registerBuiltinSourceAdapters();
  if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ cwd }) as ToolContext;

describe("ListSources", () => {
  test("lists bound sources and implicit uploads as metadata only", async () => {
    const out = await listSourcesTool({}, ctx());

    expect(out).toContain("m1");
    expect(out).toContain("alpha");
    expect(out).toContain("project-uploads");
    expect(out).toContain("brief.md");
    expect(out).not.toContain("alpha doc one 内容");
    expect(out).not.toContain("brief body");
  });
});

describe("ReadSource", () => {
  test("reads bound mock content wrapped as untrusted with provenance", async () => {
    const out = await readSourceTool(
      { source: "m1", scope: "alpha", resource: "alpha/doc-1" },
      ctx(),
    );

    expect(out).toContain("alpha doc one 内容");
    expect(out).toContain("source=m1");
    expect(out).toContain("scope=alpha");
    expect(out).toContain("resource=alpha/doc-1");
    expect(out).toMatch(/untrusted/i);
  });

  test("rejects a real resource id that does not belong to the selected scope", async () => {
    const out = await readSourceTool(
      { source: "m1", scope: "alpha", resource: "beta/note-1" },
      ctx(),
    );

    expect(out).toMatch(/^Error:/);
    expect(out).not.toContain("beta note one content");
  });

  test("denies an unbound scope, unbound source, deny policy, dangling source, and unavailable source", async () => {
    expect(
      await readSourceTool({ source: "m1", scope: "beta", resource: "beta/note-1" }, ctx()),
    ).toMatch(/^Error:/);
    expect(await readSourceTool({ source: "unbound", scope: "x", resource: "y" }, ctx())).toMatch(
      /^Error:/,
    );

    const sm = new SettingsManager(cwd, "full");
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "deny" });
    expect(
      await readSourceTool({ source: "m1", scope: "alpha", resource: "alpha/doc-1" }, ctx()),
    ).toMatch(/^Error:/);

    bindSource(sm, cwd, { sourceId: "ghost", scopes: ["x"], readPolicy: "ask" });
    expect(
      await readSourceTool({ source: "ghost", scope: "x", resource: "anything" }, ctx()),
    ).toContain("dangling");

    saveSourceDefinition({
      id: "m1",
      kind: "mock",
      label: "Mock1",
      adapterConfig: {},
      enabled: false,
    });
    bindSource(sm, cwd, { sourceId: "m1", scopes: ["alpha"], readPolicy: "ask" });
    expect(
      await readSourceTool({ source: "m1", scope: "alpha", resource: "alpha/doc-1" }, ctx()),
    ).toContain("unavailable");
  });

  test("reads uploaded files and rejects unlisted path escapes", async () => {
    const ok = await readSourceTool(
      { source: "project-uploads", scope: "uploads", resource: "brief.md" },
      ctx(),
    );

    expect(ok).toContain("brief body");
    expect(
      await readSourceTool(
        { source: "project-uploads", scope: "uploads", resource: "../secret" },
        ctx(),
      ),
    ).toMatch(/^Error:/);
  });

  test("redacts bare provider tokens before wrapping source content", async () => {
    const anthropicToken = `sk-ant-${"a".repeat(24)}`;
    const githubToken = `ghp_${"b".repeat(24)}`;
    writeFileSync(
      join(cwd, ".code-shell", "uploads", "secrets.txt"),
      `anthropic=${anthropicToken}\ngithub=${githubToken}`,
    );

    const out = await readSourceTool(
      { source: "project-uploads", scope: "uploads", resource: "secrets.txt" },
      ctx(),
    );

    expect(out).not.toContain(anthropicToken);
    expect(out).not.toContain(githubToken);
    expect(out).toContain("[REDACTED]");
    expect(out).toMatch(/untrusted/i);
  });

  test("caps content at 256 KiB and marks truncated provenance", async () => {
    writeFileSync(join(cwd, ".code-shell", "uploads", "large.txt"), `${"x".repeat(262_144)}TAIL`);

    const out = await readSourceTool(
      { source: "project-uploads", scope: "uploads", resource: "large.txt" },
      ctx(),
    );

    expect(out).toContain("truncated");
    expect(out).not.toContain("TAIL");
  });

  test("forwards the run signal and cwd to the adapter read", async () => {
    let receivedOptions: Parameters<ConnectorAdapter["read"]>[2] | undefined;
    const probeAdapter: ConnectorAdapter = {
      kind: "mock",
      async listScopes() {
        return [{ id: "alpha", label: "Alpha" }];
      },
      async listResources() {
        return [{ id: "alpha/probe", scopeId: "alpha", name: "probe" }];
      },
      async read(_definition, resourceId, options) {
        receivedOptions = options;
        return { resourceId, text: "probe body", truncated: false };
      },
    };
    registerConnectorAdapter(probeAdapter);
    const controller = new AbortController();

    const out = await readSourceTool(
      {
        source: "m1",
        scope: "alpha",
        resource: "alpha/probe",
        __signal: controller.signal,
      },
      ctx(),
    );

    expect(out).toContain("probe body");
    expect(receivedOptions).toMatchObject({ cwd, maxBytes: 262_144 });
    expect(receivedOptions?.signal).toBe(controller.signal);
  });
});

describe("source builtin registration", () => {
  test("registers adapters idempotently", () => {
    registerBuiltinSourceAdapters();
    const firstMock = connectorAdapterFor("mock");
    const firstLocal = connectorAdapterFor("local-files");
    const firstMcp = connectorAdapterFor("mcp-resource");

    registerBuiltinSourceAdapters();

    expect(firstMock).toBe(mockAdapter);
    expect(firstLocal).toBe(localFilesAdapter);
    expect(connectorAdapterFor("mock")).toBe(firstMock);
    expect(connectorAdapterFor("local-files")).toBe(firstLocal);
    expect(connectorAdapterFor("mcp-resource")).toBe(firstMcp);
  });

  test("registers metadata listing as allow and content reads as ask", () => {
    const list = BUILTIN_TOOLS.find((tool) => tool.definition.name === "ListSources");
    const read = BUILTIN_TOOLS.find((tool) => tool.definition.name === "ReadSource");

    expect(list?.definition).toMatchObject({
      source: "builtin",
      permissionDefault: "allow",
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    expect(list?.exposure.defaultPermissionRules).toEqual([
      { tool: "ListSources", decision: "allow" },
    ]);
    expect(read?.definition).toMatchObject({
      source: "builtin",
      permissionDefault: "ask",
      isReadOnly: true,
      isConcurrencySafe: true,
    });
    expect(read?.exposure.defaultPermissionRules).toBeUndefined();
  });
});
