import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { LinkSnapshot, MaskedLinkConnection } from "@cjhyy/code-shell-link";
import type { AddLinkedFileSourcesInput } from "../shared/linked-file-sources.js";

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (() => {
  networkCalls++;
  throw new Error("file selection must not fetch");
}) as typeof fetch;
const { SettingsManager } = await import("@cjhyy/code-shell-core");
const { listSourceDefinitions, readSourceDefinition, saveSourceDefinition } =
  await import("@cjhyy/code-shell-core/internal");
const { createLinkedFileSourceService } = await import("./linked-file-sources-service.js");

let home: string, cwd: string, prior: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cs-linked-files-"));
  cwd = join(home, "project");
  mkdirSync(cwd);
  prior = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(home, "state");
  networkCalls = 0;
});
afterEach(() => {
  expect(networkCalls).toBe(0);
  if (prior === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = prior;
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

function connection(providerId = "github", remote = false): MaskedLinkConnection {
  return {
    id: `${providerId}-connection`,
    providerId,
    methodId: remote ? "remote-link" : "token",
    label: `${providerId} account`,
    runtime: remote ? "server" : "local",
    authSource: remote ? "remote-link" : "manual-token",
    status: "connected",
    revision: "reviewed-revision",
    capabilityIds: [`${providerId}.get_file`],
    scope: "user",
    editable: true,
    account: {
      label: "Selected account",
      resources: ["Display label is not a resource id"],
      ...(remote
        ? {
            resourceGroups: [
              {
                id: providerId === "figma" ? "files" : "repositories",
                items: [
                  {
                    id: providerId === "figma" ? "granted_key" : "owner/docs",
                    label: "Granted file or repository",
                  },
                ],
              },
            ],
          }
        : {}),
    },
  };
}
function fixture(options: Partial<Parameters<typeof createLinkedFileSourceService>[0]> = {}) {
  let active = true;
  let connections = [connection()];
  let rootId = "root-a";
  let resolveCount = 0;
  const project = () => ({ projectId: "project-a", rootId, cwd, canonicalIdentity: cwd });
  const api = createLinkedFileSourceService({
    assertCurrent: () => {
      if (!active) throw new Error("owner revoked");
    },
    resolveProject: async () => {
      resolveCount++;
      return project();
    },
    assertProjectCurrent: () => {},
    snapshot: () =>
      ({
        connections,
        providers: [],
        revision: "snapshot",
        capabilities: { token: true, cliBinding: true, deviceAuth: false },
      }) as LinkSnapshot,
    ...options,
  });
  return {
    api,
    project,
    setConnections: (next: MaskedLinkConnection[]) => {
      connections = next;
    },
    revoke: () => {
      active = false;
    },
    changeRoot: () => {
      rootId = "root-b";
    },
    get resolveCount() {
      return resolveCount;
    },
  };
}
const input = (overrides: Partial<AddLinkedFileSourcesInput> = {}): AddLinkedFileSourcesInput => ({
  connectionId: "github-connection",
  expectedRevision: createHash("sha256")
    .update(
      JSON.stringify({
        connectionId: overrides.connectionId ?? "github-connection",
        revision: "reviewed-revision",
        project: { projectId: "project-a", rootId: "root-a", cwd, canonicalIdentity: cwd },
      }),
    )
    .digest("hex"),
  priority: "high",
  files: [{ kind: "github-file", owner: "Owner", repo: "Docs", path: "manual.md" }],
  ...overrides,
});
const bindings = () => new SettingsManager(cwd, "full").getForScope("project", cwd).sources ?? [];

test("snapshot exposes only masked ready file readers and authoritative remote ids", async () => {
  const f = fixture();
  const notion = { ...connection("notion"), capabilityIds: ["notion.get_page"] };
  f.setConnections([
    connection(),
    connection("figma", true),
    notion,
    { ...connection("gitlab"), capabilityIds: ["gitlab.list_projects"] },
    { ...connection(), id: "expired", status: "expired" },
    { ...connection(), id: "missing-capability", capabilityIds: ["github.list_issues"] },
  ]);
  const result = await f.api.snapshot("project-a");
  expect(result.connections).toHaveLength(2);
  expect(result.connections[0]).toMatchObject({
    selection: "github-file",
    resources: [],
    resourceRestricted: false,
  });
  expect(result.connections[1]).toMatchObject({
    selection: "figma-file",
    resources: [{ id: "granted_key", label: "Granted file or repository" }],
    resourceRestricted: true,
  });
  expect(result.limitations).toEqual([
    { providerId: "notion", label: "Notion", reason: "document-content-unavailable" },
    { providerId: "gitlab", label: "GitLab", reason: "file-selection-unavailable" },
    { providerId: "github", label: "GitHub", reason: "file-selection-unavailable" },
  ]);
  expect(JSON.stringify(result)).not.toContain("Display label is not a resource id");
  expect(listSourceDefinitions()).toEqual([]);
  expect(bindings()).toEqual([]);
});

test("batch adds exact high-priority file views while preserving unrelated project settings", async () => {
  new SettingsManager(cwd, "full").saveProjectSetting(
    "sources",
    [{ sourceId: "existing", scopes: ["keep"], readPolicy: "deny" }],
    cwd,
  );
  const f = fixture();
  const result = await f.api.add(
    "project-a",
    input({
      files: [
        { kind: "github-file", owner: "owner", repo: "docs", path: "manual.md" },
        {
          kind: "github-file",
          owner: "owner",
          repo: "docs",
          path: "guide.md",
          ref: "release/docs",
        },
        { kind: "github-file", owner: "Owner", repo: "Docs", path: "manual.md" },
      ],
    }),
  );
  expect(result.sourceIds).toHaveLength(2);
  expect(listSourceDefinitions()).toHaveLength(2);
  expect(bindings()).toEqual([
    { sourceId: "existing", scopes: ["keep"], readPolicy: "deny" },
    ...result.sourceIds.map((sourceId) => ({
      sourceId,
      scopes: ["github:get_file"],
      readPolicy: "ask",
      priority: "high",
    })),
  ]);
  expect(readSourceDefinition(result.sourceIds[0]!)).toMatchObject({
    kind: "link",
    credentialRef: "github-connection",
    enabled: true,
    adapterConfig: {
      providerId: "github",
      action: "get_file",
      params: { owner: "owner", repo: "docs", path: "manual.md" },
    },
  });
  expect(f.resolveCount).toBe(2);
});

test("local legacy read grants remain selectable while remote grants require explicit capability", async () => {
  const f = fixture();
  f.setConnections([
    { ...connection(), capabilityIds: [] },
    { ...connection("figma", true), capabilityIds: [] },
  ]);
  expect((await f.api.snapshot("project-a")).connections.map((item) => item.id)).toEqual([
    "github-connection",
  ]);
  expect((await f.api.add("project-a", input())).sourceIds).toHaveLength(1);
});

test("repeated selection reuses stable ids, preserves renamed definitions and deny policy", async () => {
  const f = fixture();
  const first = await f.api.add("project-a", input());
  const definition = readSourceDefinition(first.sourceIds[0]!)!;
  saveSourceDefinition({ ...definition, label: "User renamed file" });
  new SettingsManager(cwd, "full").saveProjectSetting(
    "sources",
    [
      {
        sourceId: definition.id,
        scopes: ["github:get_file"],
        readPolicy: "deny",
        priority: "normal",
      },
    ],
    cwd,
  );
  expect(await f.api.add("project-a", input())).toEqual(first);
  expect(readSourceDefinition(definition.id)!.label).toBe("User renamed file");
  expect(bindings()).toEqual([
    { sourceId: definition.id, scopes: ["github:get_file"], readPolicy: "deny", priority: "high" },
  ]);
  expect(listSourceDefinitions()).toHaveLength(1);
});

test.each(["disabled", "changed"])(
  "existing %s definitions are preserved and never rebound",
  async (mode) => {
    const f = fixture();
    const first = await f.api.add("project-a", input());
    const source = readSourceDefinition(first.sourceIds[0]!)!;
    const changed =
      mode === "disabled"
        ? { ...source, enabled: false }
        : {
            ...source,
            adapterConfig: {
              ...source.adapterConfig,
              params: { owner: "owner", repo: "docs", path: "another.md" },
            },
          };
    saveSourceDefinition(changed);
    new SettingsManager(cwd, "full").saveProjectSetting("sources", [], cwd);
    await expect(f.api.add("project-a", input())).rejects.toThrow();
    expect(readSourceDefinition(source.id)).toEqual(changed);
    expect(bindings()).toEqual([]);
  },
);

test("remote file authorization uses exact groups and URL/key selection deduplicates", async () => {
  const f = fixture();
  f.setConnections([connection("figma", true)]);
  const selection = input({
    connectionId: "figma-connection",
    files: [{ kind: "figma-file", fileUrlOrKey: "https://figma.com/design/granted_key/title" }],
  });
  const first = await f.api.add("project-a", selection);
  expect(
    await f.api.add("project-a", {
      ...selection,
      files: [{ kind: "figma-file", fileUrlOrKey: "granted_key" }],
    }),
  ).toEqual(first);
  expect(readSourceDefinition(first.sourceIds[0]!)!.adapterConfig).toEqual({
    providerId: "figma",
    action: "get_file",
    params: { file_url_or_key: "granted_key" },
  });
  await expect(
    f.api.add("project-a", {
      ...selection,
      files: [{ kind: "figma-file", fileUrlOrKey: "ungranted_key" }],
    }),
  ).rejects.toThrow("授权范围");
  const displayOnly = connection("figma", true);
  delete displayOnly.account!.resourceGroups;
  displayOnly.account!.resources = ["granted_key"];
  f.setConnections([displayOnly]);
  await expect(f.api.add("project-a", selection)).rejects.toThrow("授权范围");
  expect(listSourceDefinitions()).toHaveLength(1);
});

test.each(["revision", "availability", "capability", "resource"])(
  "rechecks %s after project resolution before writing",
  async (change) => {
    let resolves = 0;
    let conn = connection("github", true);
    const f = fixture({
      resolveProject: async () => {
        if (++resolves === 2) {
          if (change === "revision") conn = { ...conn, revision: "changed" };
          if (change === "availability") conn = { ...conn, status: "unavailable" };
          if (change === "capability") conn = { ...conn, capabilityIds: [] };
          if (change === "resource")
            conn = { ...conn, account: { ...conn.account!, resourceGroups: [] } };
        }
        return { projectId: "project-a", rootId: "root-a", cwd, canonicalIdentity: cwd };
      },
      snapshot: () => ({ connections: [conn] }) as LinkSnapshot,
    });
    await expect(f.api.add("project-a", input())).rejects.toThrow();
    expect(listSourceDefinitions()).toEqual([]);
    expect(bindings()).toEqual([]);
  },
);

test("a changed project primary and a revoked pending owner perform zero writes", async () => {
  let count = 0;
  const f = fixture({
    resolveProject: async () => ({
      projectId: "project-a",
      rootId: ++count === 1 ? "root-a" : "root-b",
      cwd,
      canonicalIdentity: cwd,
    }),
  });
  await expect(f.api.add("project-a", input())).rejects.toThrow("项目主目录");
  let finish!: (value: ReturnType<typeof f.project>) => void;
  const pending = fixture({
    resolveProject: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const adding = pending.api.add("project-a", input());
  pending.revoke();
  finish(pending.project());
  await expect(adding).rejects.toThrow("owner revoked");
  expect(listSourceDefinitions()).toEqual([]);
  expect(bindings()).toEqual([]);
});

test("invalid batch rejects unknown JSON before any catalog or binding changes", async () => {
  const f = fixture();
  await expect(
    f.api.add(
      "project-a",
      input({
        files: [
          input().files[0]!,
          { kind: "github-file", owner: "owner", repo: "docs", path: "../outside" },
        ],
      }),
    ),
  ).rejects.toThrow();
  await expect(
    f.api.add("project-a", { ...input(), token: "not-accepted" } as any),
  ).rejects.toThrow();
  expect(listSourceDefinitions()).toEqual([]);
  expect(bindings()).toEqual([]);
});

test("a failed project save retains safe references and retry reuses them without duplicates", async () => {
  let fail = true;
  const f = fixture({
    settings: (cwd) => ({
      mutateSettingsForScope(scope, path, mutate) {
        if (fail) throw new Error("synthetic project write failure");
        new SettingsManager(cwd, "full").mutateSettingsForScope(scope, path, mutate);
      },
    }),
  });
  await expect(f.api.add("project-a", input())).rejects.toThrow("项目引用未保存；文件引用已保留");
  expect(bindings()).toEqual([]);
  const created = listSourceDefinitions();
  expect(created).toHaveLength(1);
  fail = false;
  expect(await f.api.add("project-a", input())).toEqual({ sourceIds: [created[0]!.id] });
  expect(listSourceDefinitions()).toEqual(created);
  expect(bindings()).toHaveLength(1);
});

test("failure in one project cannot delete the shared reference another project just reused", async () => {
  const other = join(home, "other-project");
  mkdirSync(other);
  const modulePath = new URL("./linked-file-sources-service.ts", import.meta.url).pathname;
  const f = fixture({
    settings: () => ({
      mutateSettingsForScope() {
        const script = `
        globalThis.fetch = () => { throw new Error("selection network denied"); };
        const { createLinkedFileSourceService } = await import(${JSON.stringify(modulePath)});
        const api = createLinkedFileSourceService({
          assertCurrent() {}, assertProjectCurrent() {},
          resolveProject: async () => (${JSON.stringify({ projectId: "project-b", rootId: "root-b", cwd: other, canonicalIdentity: other })}),
          snapshot: () => (${JSON.stringify({ connections: [connection()] })})
        });
        const snapshot = await api.snapshot("project-b");
        await api.add("project-b", { ...${JSON.stringify(input())}, expectedRevision: snapshot.connections[0].revision });
      `;
        const child = Bun.spawnSync([process.execPath, "-e", script], {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        });
        expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
          exitCode: 0,
          stderr: "",
        });
        throw new Error("first project write failed after concurrent reuse");
      },
    }),
  });
  await expect(f.api.add("project-a", input())).rejects.toThrow("项目引用未保存");
  expect(bindings()).toEqual([]);
  const shared = listSourceDefinitions();
  expect(shared).toHaveLength(1);
  expect(new SettingsManager(other, "full").getForScope("project", other).sources).toEqual([
    { sourceId: shared[0]!.id, scopes: ["github:get_file"], readPolicy: "ask", priority: "high" },
  ]);
});

test("concurrent project writers retain every independent file binding", async () => {
  const modulePath = new URL("./linked-file-sources-service.ts", import.meta.url).pathname;
  const total = 4;
  const children = Array.from({ length: total }, (_, index) => {
    const script = `
      globalThis.fetch = () => { throw new Error("selection network denied"); };
      const { createLinkedFileSourceService } = await import(${JSON.stringify(modulePath)});
      const api = createLinkedFileSourceService({
        assertCurrent() {}, assertProjectCurrent() {},
        resolveProject: async () => (${JSON.stringify({ projectId: "project-a", rootId: "root-a", cwd, canonicalIdentity: cwd })}),
        snapshot: () => (${JSON.stringify({ connections: [connection()] })})
      });
      await api.add("project-a", ${JSON.stringify(input({ files: [{ kind: "github-file", owner: "owner", repo: "docs", path: `file-${index}.md` }] }))});
    `;
    return Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  });
  const results = await Promise.all(
    children.map(async (child) => ({
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
  expect(results).toEqual(Array.from({ length: total }, () => ({ exitCode: 0, stderr: "" })));
  expect(bindings()).toHaveLength(total);
  expect(listSourceDefinitions()).toHaveLength(total);
  expect(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf8")).toContain("high");
}, 30_000);
