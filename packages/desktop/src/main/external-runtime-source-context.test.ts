import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_AGENT_PRESETS,
  SessionManager,
  SettingsManager,
  ToolRegistry,
} from "@cjhyy/code-shell-core";
import { createSessionToolHost, type ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  activateWorkspaceProfile,
  bindSource,
  deactivateWorkspaceProfile,
  deleteWorkspaceProfile,
  saveSourceDefinition,
  saveWorkspaceProfile,
} from "@cjhyy/code-shell-core/internal";
import { registerConnectorAdapter } from "../../../core/src/sources/adapter.js";
import { mockAdapter } from "../../../core/src/sources/adapters/mock.js";
import {
  listSourcesTool,
  readSourceTool,
  registerBuiltinSourceAdapters,
} from "../../../core/src/tool-system/builtin/sources.js";
import { createExternalRuntimeSourceContext } from "./external-runtime-source-context.js";

let home: string;
let cwd: string;
let previousHome: string | undefined;
let sessions: SessionManager;
let settings: SettingsManager;
const sessionId = "external-source-authority";

function saveProfile(name: string, scopes: string[]) {
  saveWorkspaceProfile({
    name,
    label: name,
    basePreset: "general",
    sourceAccess: [{ sourceId: "docs", scopes, readPolicy: "ask" }],
  });
}

function context(): ToolContext {
  return {
    cwd,
    settingsScope: "full",
    ...createExternalRuntimeSourceContext({ sessionId, cwd, sessions }),
  } as ToolContext;
}

const readAlpha = (ctx: ToolContext) =>
  readSourceTool({ source: "docs", scope: "alpha", resource: "alpha/doc-1" }, ctx);

beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  home = mkdtempSync(join(tmpdir(), "codeshell-external-source-context-"));
  process.env.CODE_SHELL_HOME = home;
  cwd = join(home, "workspace");
  mkdirSync(cwd);
  sessions = new SessionManager();
  sessions.create(cwd, "fixture-model", "fixture", sessionId);
  sessions.updateSessionState(sessionId, { workspaceProfile: "limited" });
  settings = new SettingsManager(cwd, "full");
  saveSourceDefinition({
    id: "docs",
    kind: "mock",
    label: "Docs",
    adapterConfig: {},
    enabled: true,
  });
  bindSource(settings, cwd, { sourceId: "docs", scopes: ["alpha", "beta"], readPolicy: "ask" });
  saveProfile("limited", ["alpha"]);
  saveProfile("broad", ["alpha", "beta"]);
  activateWorkspaceProfile(settings, "broad", cwd);
  registerBuiltinSourceAdapters();
});

afterEach(() => {
  registerBuiltinSourceAdapters();
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("external runtime source authority", () => {
  test("pins the business Session profile over the broader project default", async () => {
    const ctx = context();
    expect(ctx.workspaceProfileName).toBe("limited");
    expect(ctx.isSourceProfileCurrent!()).toBe(true);
    const listing = await listSourcesTool({}, ctx);
    expect(listing).toContain("alpha");
    expect(listing).not.toContain("beta");
    expect(await readAlpha(ctx)).toContain("alpha doc one 内容");
    expect(
      await readSourceTool({ source: "docs", scope: "beta", resource: "beta/note-1" }, ctx),
    ).toMatch(/^Error:/);
  });

  test("normal state updates and unrelated project profile changes retain the Session pin", () => {
    const ctx = context();
    sessions.updateSessionState(sessionId, { status: "completed", turnCount: 3 });
    activateWorkspaceProfile(settings, "limited", cwd);
    expect(ctx.isSourceProfileCurrent!()).toBe(true);
  });

  test("a changed Session pin revokes the old Run, including after the pin is restored", async () => {
    const ctx = context();
    sessions.updateSessionState(sessionId, { workspaceProfile: "broad" });
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    sessions.updateSessionState(sessionId, { workspaceProfile: "limited" });
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    expect(await readAlpha(ctx)).toMatch(/^Error:/);
    expect(await listSourcesTool({}, ctx)).not.toContain("Docs");
    expect(context().isSourceProfileCurrent!()).toBe(true);
  });

  test("clearing a Session pin revokes even if the project selects the same profile", () => {
    activateWorkspaceProfile(settings, "limited", cwd);
    const ctx = context();
    sessions.updateSessionState(sessionId, { workspaceProfile: undefined });
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
  });

  test("editing the same profile before a call cannot widen the captured Run's scopes", async () => {
    const ctx = context();
    saveProfile("limited", ["alpha", "beta"]);
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    expect(
      await readSourceTool({ source: "docs", scope: "beta", resource: "beta/note-1" }, ctx),
    ).toMatch(/^Error:/);
    expect(await listSourcesTool({}, ctx)).not.toContain("beta");
    expect(context().isSourceProfileCurrent!()).toBe(true);
  });

  test("an unpinned Session captures the effective project profile", async () => {
    sessions.updateSessionState(sessionId, { workspaceProfile: undefined });
    const ctx = context();
    expect(ctx.workspaceProfileName).toBe("broad");
    expect(await listSourcesTool({}, ctx)).toContain("beta");
    expect(await readAlpha(ctx)).toContain("alpha doc one 内容");
    activateWorkspaceProfile(settings, "limited", cwd);
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
  });

  test("selecting a profile revokes a Run which began without a selected profile", async () => {
    sessions.updateSessionState(sessionId, { workspaceProfile: undefined });
    deactivateWorkspaceProfile(settings, cwd);
    const ctx = context();
    expect(ctx.workspaceProfileName).toBeUndefined();
    expect(ctx.isSourceProfileCurrent!()).toBe(true);
    expect(await listSourcesTool({}, ctx)).toContain("beta");
    expect(await readAlpha(ctx)).toContain("alpha doc one 内容");
    activateWorkspaceProfile(settings, "limited", cwd);
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
  });

  test.each([false, true])(
    "full settings scope preserves projectTrusted=%j for actual source execution",
    async (projectTrusted) => {
      settings.saveProjectSetting(
        "permissions",
        { rules: [{ tool: "ReadSource", decision: "allow" }] },
        cwd,
      );
      const approvals: string[] = [];
      const host = createSessionToolHost({
        businessSessionId: sessionId,
        cwd,
        registry: new ToolRegistry({ builtinTools: ["ListSources", "ReadSource"] }),
        permissionMode: "default",
        settingsScope: "full",
        presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
        projectTrusted,
        planMode: false,
        exposure: { mode: "allowlist", toolNames: new Set(["ListSources", "ReadSource"]) },
        visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
        contextOverrides: createExternalRuntimeSourceContext({ sessionId, cwd, sessions }),
        approvalBackend: {
          requestApproval: async (request) => {
            approvals.push(request.toolName);
            return { approved: false };
          },
        },
      });
      try {
        const listing = await host.execute({ id: "metadata", name: "ListSources", input: {} });
        expect(listing.isError).toBeFalsy();
        expect(listing.result).toContain("alpha");
        expect(listing.result).not.toContain("beta");
        const result = await host.execute({
          id: "read",
          name: "ReadSource",
          input: { source: "docs", scope: "alpha", resource: "alpha/doc-1" },
        });
        if (projectTrusted) {
          expect(result.isError).toBeFalsy();
          expect(result.result).toContain("alpha doc one 内容");
          expect(approvals).toEqual([]);
        } else {
          expect(result.isError).toBe(true);
          expect(String(result.error ?? result.result)).not.toContain("alpha doc one");
          expect(approvals).toEqual(["ReadSource"]);
        }
      } finally {
        await host.dispose();
      }
    },
  );

  test.each(["missing-profile", ""])(
    "unavailable Session pin %j cannot use project fallback",
    async (pin) => {
      sessions.updateSessionState(sessionId, { workspaceProfile: pin });
      const ctx = context();
      expect(ctx.isSourceProfileCurrent!()).toBe(false);
      expect(await listSourcesTool({}, ctx)).not.toContain("Docs");
      expect(await readAlpha(ctx)).toMatch(/^Error:/);
    },
  );

  test("a missing selected project profile cannot become an unrestricted Run", async () => {
    sessions.updateSessionState(sessionId, { workspaceProfile: undefined });
    deleteWorkspaceProfile("broad");
    const ctx = context();
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    deactivateWorkspaceProfile(settings, cwd);
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    expect(await readAlpha(ctx)).toMatch(/^Error:/);
  });

  test("a missing Session fails closed and does not attach to a later Session", async () => {
    const captured = createExternalRuntimeSourceContext({
      sessionId: "later-session",
      cwd,
      sessions,
    });
    const ctx = { cwd, settingsScope: "full", ...captured } as ToolContext;
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    sessions.create(cwd, "fixture-model", "fixture", "later-session");
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    expect(await readAlpha(ctx)).toMatch(/^Error:/);
  });

  test("a Session belonging to a different workspace fails closed", async () => {
    const ctx = {
      cwd,
      settingsScope: "full",
      ...createExternalRuntimeSourceContext({ sessionId, cwd: join(home, "other"), sessions }),
    } as ToolContext;
    expect(ctx.isSourceProfileCurrent!()).toBe(false);
    expect(await readAlpha(ctx)).toMatch(/^Error:/);
  });

  test.each([false, true])(
    "a replacement Session cannot retain old authority (observe deletion: %j)",
    (observeDeletion) => {
      const ctx = context();
      const initial = sessions.readSessionState(sessionId)!;
      rmSync(join(sessions.getStorageDir(), sessionId), { recursive: true });
      if (observeDeletion) expect(ctx.isSourceProfileCurrent!()).toBe(false);
      sessions.create(cwd, "fixture-model", "fixture", sessionId);
      sessions.updateSessionState(sessionId, {
        workspaceProfile: "limited",
        startedAt: initial.startedAt + 1,
      });
      expect(ctx.isSourceProfileCurrent!()).toBe(false);
    },
  );

  test.each(["metadata", "content", "profile-config", "profile-deletion"])(
    "rejects data when authority changes during %s await",
    async (stage) => {
      const ctx = context();
      let reads = 0;
      const revoke = () => {
        if (stage === "profile-config") saveProfile("limited", []);
        else if (stage === "profile-deletion") deleteWorkspaceProfile("limited");
        else sessions.updateSessionState(sessionId, { workspaceProfile: "broad" });
      };
      registerConnectorAdapter({
        ...mockAdapter,
        async listResources(...args) {
          const result = await mockAdapter.listResources(...args);
          if (stage === "metadata") revoke();
          return result;
        },
        async read(...args) {
          reads++;
          const result = await mockAdapter.read(...args);
          revoke();
          return result;
        },
      });
      const result = await readAlpha(ctx);
      expect(result).toContain("authorization changed");
      expect(result).not.toContain("alpha doc one");
      expect(reads).toBe(stage === "metadata" ? 0 : 1);
      expect(ctx.isSourceProfileCurrent!()).toBe(false);
    },
  );
});
