import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess } from "../credentials/access.js";
import { SettingsManager } from "../settings/manager.js";
import { bindSource } from "../sources/binding.js";
import { saveSourceDefinition } from "../sources/catalog.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";
import { FIRST_PHASE_EXPOSURE } from "./external-tool-exposure.js";
import { ToolRegistry } from "./registry.js";
import { createSessionToolHost, type SessionToolHost } from "./session-tool-host.js";
import { registerBuiltinSourceAdapters } from "./builtin/sources.js";

let directory: string;
let cwd: string;
let previousHome: string | undefined;
const hosts: SessionToolHost[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-external-host-tools-"));
  cwd = join(directory, "workspace");
  mkdirSync(cwd);
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(directory, "state");
  registerBuiltinSourceAdapters();
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  setDefaultCredentialAccess(null);
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

function host(approved = true, approvals: string[] = []) {
  const value = createSessionToolHost({
    businessSessionId: "external-session",
    cwd,
    registry: new ToolRegistry({}),
    permissionMode: "default",
    settingsScope: "full",
    presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
    projectTrusted: true,
    planMode: false,
    exposure: FIRST_PHASE_EXPOSURE,
    visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
    approvalBackend: {
      requestApproval: async (request) => {
        approvals.push(request.toolName);
        return { approved };
      },
    },
  });
  hosts.push(value);
  return value;
}

test("external discovery advertises real Link and source tools and cannot load excluded tools", async () => {
  const external = host();
  expect(external.listTools().map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["LinkAction", "ListSources", "ReadSource", "ToolSearch"]),
  );
  const discovered = await external.execute({
    id: "discover",
    name: "ToolSearch",
    input: { query: "LinkAction" },
  });
  expect(discovered.isError).toBeFalsy();
  expect(discovered.result).toContain("LinkAction");
  const excluded = await external.execute({
    id: "excluded",
    name: "ToolSearch",
    input: { query: "select:Agent,UseCredential" },
  });
  expect(excluded.result).toContain('Tool "Agent" not found');
  expect(excluded.result).toContain('Tool "UseCredential" not found');
  const call = await external.execute({ id: "cannot-call", name: "UseCredential", input: {} });
  expect(call.isError).toBe(true);
  expect(call.error).toContain("not exposed");
});

test("external Link discovery returns connection metadata without resolving secrets", async () => {
  let secrets = 0;
  setDefaultCredentialAccess({
    listMasked: () => [
      {
        id: "connected-github",
        type: "link",
        label: "GitHub account",
        hasSecret: true,
        meta: {
          linkProvider: "github",
          linkExecutionRuntime: "local",
          linkExecutionBackend: "http-token",
        },
      },
    ],
    resolveMeta: () => undefined,
    envExposures: () => ({}),
    resolveValue: async () => {
      secrets += 1;
      throw new Error("Discovery cannot read credentials");
    },
  });
  const result = await host().execute({ id: "links", name: "LinkAction", input: {} });
  expect(result.isError).toBeFalsy();
  const output = JSON.parse(String(result.result));
  expect(output.kind).toBe("providers");
  expect(
    output.providers.find((provider: { id: string }) => provider.id === "github").connections,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "connected-github" })]));
  expect(secrets).toBe(0);
});

test("bound source metadata, approved content and revocation use the real external executor", async () => {
  saveSourceDefinition({
    id: "material",
    kind: "mock",
    label: "Bound material",
    adapterConfig: {},
    enabled: true,
  });
  const settings = new SettingsManager(cwd, "full");
  bindSource(settings, cwd, { sourceId: "material", scopes: ["alpha"], readPolicy: "ask" });
  const approvals: string[] = [];
  const external = host(true, approvals);
  const listing = await external.execute({ id: "list", name: "ListSources", input: {} });
  expect(listing.result).toContain("Bound material");
  expect(listing.result).not.toContain("alpha doc one 内容");
  expect(approvals).toEqual([]);
  const input = { source: "material", scope: "alpha", resource: "alpha/doc-1" };
  const content = await external.execute({ id: "read", name: "ReadSource", input });
  expect(content.isError).toBeFalsy();
  expect(content.result).toContain("alpha doc one 内容");
  expect(content.result).toContain("untrusted");
  expect(approvals).toEqual(["ReadSource"]);
  bindSource(settings, cwd, { sourceId: "material", scopes: ["alpha"], readPolicy: "deny" });
  const revoked = await external.execute({ id: "revoked", name: "ReadSource", input });
  expect(revoked.isError).toBe(true);
  expect(String(revoked.error ?? revoked.result)).not.toContain("alpha doc one 内容");
});

test("denying an external source read returns no protected content", async () => {
  saveSourceDefinition({
    id: "material",
    kind: "mock",
    label: "Bound material",
    adapterConfig: {},
    enabled: true,
  });
  bindSource(new SettingsManager(cwd, "full"), cwd, {
    sourceId: "material",
    scopes: ["alpha"],
    readPolicy: "ask",
  });
  const result = await host(false).execute({
    id: "denied",
    name: "ReadSource",
    input: { source: "material", scope: "alpha", resource: "alpha/doc-1" },
  });
  expect(result.isError).toBe(true);
  expect(String(result.error ?? result.result)).not.toContain("alpha doc one 内容");
});
