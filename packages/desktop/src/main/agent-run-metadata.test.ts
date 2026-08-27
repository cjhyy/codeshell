import { describe, expect, test } from "bun:test";
import {
  AgentRunMetadataError,
  prepareAgentRunMetadata,
  resolveCredentialSessionCwd,
} from "./agent-run-metadata.js";
import { createWorkspaceContext } from "@cjhyy/code-shell-core/internal";

const projectContext = createWorkspaceContext({
  projectId: "p1",
  projectRevision: 3,
  sessionMainRootId: "r1",
  roots: [
    { id: "r1", path: "/primary", role: "primary" },
    { id: "r2", path: "/secondary", role: "secondary" },
  ],
});

function baseDeps() {
  return {
    isProjectTrusted: (cwd: string) => cwd === "/primary" || cwd === "/repo",
    isNoRepoCwd: (cwd: string) => cwd === "/no-repo",
    lookupSession: () => undefined,
    resolveExactRoot: (cwd: string) =>
      cwd === "/primary" || cwd === "/secondary"
        ? {
            cwd,
            trustCwd: cwd,
            projectId: "p1",
            mainRootId: cwd === "/primary" ? "r1" : "r2",
            projectPrimaryRootId: "r1",
            workspaceContext:
              cwd === "/primary"
                ? projectContext
                : createWorkspaceContext({
                    projectId: "p1",
                    projectRevision: 3,
                    sessionMainRootId: "r2",
                    roots: [
                      { id: "r1", path: "/primary", role: "secondary" },
                      { id: "r2", path: "/secondary", role: "primary" },
                    ],
                  }),
          }
        : undefined,
    resolveProjectRun: () => ({
      cwd: "/primary",
      trustCwd: "/primary",
      projectId: "p1",
      mainRootId: "r1",
      projectPrimaryRootId: "r1",
      workspaceContext: projectContext,
    }),
    hostReservation: () => undefined,
  };
}

describe("prepareAgentRunMetadata", () => {
  const meta = { origin: "renderer" as const, producer: "agent:msg" };
  test("strips main-only browser routing fields and injects main-owned trust", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: {
        cwd: "/repo",
        sessionId: "s1",
        bucket: "repo::s1",
        browserPartition: "persist:browser:repo::s1",
        projectTrusted: true,
        prompt: "hi",
      },
    });

    const prepared = prepareAgentRunMetadata(line, meta, {
      ...baseDeps(),
      isNoRepoCwd: (cwd) => cwd === "/repo",
    });
    expect(prepared).toMatchObject({
      cwd: "/repo",
      sessionId: "s1",
      bucket: "repo::s1",
      browserPartition: "persist:browser:repo::s1",
    });
    const out = JSON.parse(prepared.outLine) as {
      params: Record<string, unknown>;
    };
    expect(out.params.bucket).toBeUndefined();
    expect(out.params.browserPartition).toBeUndefined();
    expect(out.params.projectTrusted).toBe(true);
    expect(out.params.prompt).toBe("hi");
  });

  test("main-owned trust fails closed when cwd is absent or untrusted", () => {
    expect(() =>
      prepareAgentRunMetadata(
        JSON.stringify({ method: "agent/run", params: { sessionId: "s1", projectTrusted: true } }),
        meta,
        { ...baseDeps(), isNoRepoCwd: () => true, isProjectTrusted: () => true },
      ),
    ).toThrow(/requires an authorized cwd/);

    const untrusted = prepareAgentRunMetadata(
      JSON.stringify({
        method: "agent/run",
        params: { sessionId: "s2", cwd: "/repo", projectTrusted: true },
      }),
      meta,
      { ...baseDeps(), isNoRepoCwd: () => true, isProjectTrusted: () => false },
    );
    expect(JSON.parse(untrusted.outLine).params.projectTrusted).toBe(false);
  });

  test("non-run or malformed lines pass through", () => {
    const query = JSON.stringify({ method: "agent/query", params: { sessionId: "s1" } });
    expect(prepareAgentRunMetadata(query, meta, baseDeps()).outLine).toBe(query);
    expect(prepareAgentRunMetadata("{not json", meta, baseDeps()).outLine).toBe("{not json");
  });

  test("records trusted origin metadata and strips renderer-supplied workspace authority", () => {
    const prepared = prepareAgentRunMetadata(
      JSON.stringify({
        method: "agent/run",
        params: { sessionId: "s1", cwd: "/repo", workspaceContext: { projectId: "forged" } },
      }),
      meta,
      { ...baseDeps(), isNoRepoCwd: () => true, isProjectTrusted: () => false },
    );
    expect(prepared.meta).toEqual(meta);
    expect(JSON.parse(prepared.outLine).params.workspaceContext).toBeUndefined();
  });

  test("projectId makes Main replace cwd and rejects unknown projects", () => {
    const line = JSON.stringify({
      method: "agent/run",
      params: { projectId: "p1", sessionId: "s1", cwd: "/forged" },
    });
    const prepared = prepareAgentRunMetadata(line, meta, {
      isProjectTrusted: (cwd) => cwd === "/primary",
      ...baseDeps(),
    });
    expect(JSON.parse(prepared.outLine).params).toMatchObject({
      projectId: "p1",
      sessionId: "s1",
      cwd: "/primary",
      projectTrusted: true,
    });
    expect(() =>
      prepareAgentRunMetadata(line, meta, {
        ...baseDeps(),
        resolveProjectRun: () => {
          throw new Error("project not found");
        },
      }),
    ).toThrow(/project not found/);
  });

  test("injects a complete authoritative context for a project run", () => {
    const prepared = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { sessionId: "new", projectId: "p1" } }),
      meta,
      baseDeps(),
    );
    const params = JSON.parse(prepared.outLine).params;
    expect(params.workspaceContext).toEqual(projectContext);
    expect(params.cwd).toBe("/primary");
    expect(prepared.tentative).toMatchObject({ cwd: "/primary", projectId: "p1" });
  });

  test("cold explicit-project runs resolve ordinary forks and externally created Sessions from one state read", () => {
    const cases = [
      {
        name: "ordinary fork",
        entry: {
          sessionId: "ordinary-fork",
          cwd: "/secondary",
          status: "confirmed" as const,
        },
        resolution: {
          cwd: "/secondary",
          trustCwd: "/secondary",
          projectId: "p1",
          mainRootId: "r2",
          projectPrimaryRootId: "r1",
          workspaceContext: createWorkspaceContext({
            projectId: "p1",
            projectRevision: 3,
            sessionMainRootId: "r2",
            roots: [
              { id: "r1", path: "/primary", role: "secondary" },
              { id: "r2", path: "/secondary", role: "primary" },
            ],
          }),
        },
      },
      {
        name: "externally created bound Session",
        entry: {
          sessionId: "external-session",
          cwd: "/primary",
          workspaceRoot: "/worktree",
          projectId: "p1",
          mainRootId: "r1",
          status: "confirmed" as const,
        },
        resolution: {
          cwd: "/worktree",
          trustCwd: "/primary",
          projectId: "p1",
          mainRootId: "r1",
          projectPrimaryRootId: "r1",
          workspaceContext: projectContext,
        },
      },
    ];

    for (const scenario of cases) {
      const lookups: boolean[] = [];
      let resolverEntry: unknown;
      const prepared = prepareAgentRunMetadata(
        JSON.stringify({
          method: "agent/run",
          params: { sessionId: scenario.entry.sessionId, projectId: "p1", cwd: "/forged" },
        }),
        meta,
        {
          ...baseDeps(),
          lookupSession: (_sessionId, refresh) => {
            lookups.push(refresh);
            return refresh ? scenario.entry : undefined;
          },
          resolveProjectRun: (...args: unknown[]) => {
            resolverEntry = args[2];
            if (resolverEntry !== scenario.entry) {
              throw new Error("explicit project resolver requires the confirmed Session entry");
            }
            return scenario.resolution;
          },
        },
      );

      expect(lookups, scenario.name).toEqual([false, true]);
      expect(resolverEntry, scenario.name).toBe(scenario.entry);
      expect(JSON.parse(prepared.outLine).params.cwd, scenario.name).toBe(scenario.resolution.cwd);
      expect(prepared.tentative, scenario.name).toBeUndefined();
    }
  });

  test("cold explicit-project runs reject persisted binding and legacy cwd mismatches", () => {
    const cases = [
      {
        name: "binding mismatch",
        entry: {
          sessionId: "bound-elsewhere",
          cwd: "/primary",
          projectId: "p2",
          mainRootId: "other-root",
          status: "confirmed" as const,
        },
        message: "session project binding does not match the requested project",
      },
      {
        name: "legacy cwd mismatch",
        entry: {
          sessionId: "legacy-elsewhere",
          cwd: "/unmounted",
          status: "confirmed" as const,
        },
        message: "session main root is not mounted in the project",
      },
    ];

    for (const scenario of cases) {
      let refreshes = 0;
      expect(
        () =>
          prepareAgentRunMetadata(
            JSON.stringify({
              method: "agent/run",
              params: { sessionId: scenario.entry.sessionId, projectId: "p1" },
            }),
            meta,
            {
              ...baseDeps(),
              lookupSession: (_sessionId, refresh) => {
                if (refresh) refreshes += 1;
                return refresh ? scenario.entry : undefined;
              },
              resolveProjectRun: (...args: unknown[]) => {
                const entry = args[2] as typeof scenario.entry | undefined;
                if (!entry) return baseDeps().resolveProjectRun();
                if (entry.projectId && entry.projectId !== "p1") {
                  throw new Error("session project binding does not match the requested project");
                }
                if (entry.cwd !== "/primary" && entry.cwd !== "/secondary") {
                  throw new Error("session main root is not mounted in the project");
                }
                return baseDeps().resolveProjectRun();
              },
            },
          ),
        scenario.name,
      ).toThrow(scenario.message);
      expect(refreshes, scenario.name).toBe(1);
    }
  });

  test("renderer existing-session mismatch refreshes once, then fails closed", () => {
    let refreshes = 0;
    const deps = {
      ...baseDeps(),
      lookupSession: (_sessionId: string, refresh: boolean) => {
        if (refresh) refreshes += 1;
        return {
          sessionId: "s1",
          cwd: "/primary",
          workspaceRoot: "/worktree",
          status: "confirmed" as const,
        };
      },
    };
    expect(() =>
      prepareAgentRunMetadata(
        JSON.stringify({ method: "agent/run", params: { sessionId: "s1", cwd: "/forged" } }),
        meta,
        deps,
      ),
    ).toThrow(/does not match persisted Session/);
    expect(refreshes).toBe(1);

    const healed = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { sessionId: "s1", cwd: "/worktree-new" } }),
      meta,
      {
        ...deps,
        lookupSession: (_sessionId, refresh) =>
          refresh
            ? {
                sessionId: "s1",
                cwd: "/primary",
                workspaceRoot: "/worktree-new",
                status: "confirmed",
              }
            : { sessionId: "s1", cwd: "/primary", workspaceRoot: "/old", status: "confirmed" },
      },
    );
    expect(JSON.parse(healed.outLine).params.cwd).toBe("/worktree-new");
  });

  test("host existing Session ignores a supplied cwd, while renderer cannot use a host reservation", () => {
    const lookupSession = () => ({
      sessionId: "s1",
      cwd: "/primary",
      workspaceRoot: "/worktree",
      status: "confirmed" as const,
    });
    const host = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { sessionId: "s1", cwd: "/forged" } }),
      { origin: "host", producer: "pet" },
      { ...baseDeps(), lookupSession },
    );
    expect(JSON.parse(host.outLine).params.cwd).toBe("/worktree");

    const reserved = {
      ...baseDeps(),
      hostReservation: () => ({ cwd: "/reserved", producer: "pet", reservedAt: 1 }),
    };
    expect(() =>
      prepareAgentRunMetadata(
        JSON.stringify({ method: "agent/run", params: { sessionId: "new", cwd: "/reserved" } }),
        meta,
        reserved,
      ),
    ).toThrow(/not authorized/);
    expect(
      JSON.parse(
        prepareAgentRunMetadata(
          JSON.stringify({ method: "agent/run", params: { sessionId: "new", cwd: "/reserved" } }),
          { origin: "host", producer: "pet" },
          reserved,
        ).outLine,
      ).params.cwd,
    ).toBe("/reserved");
  });

  test("renderer and mobile cannot bypass cwd matching through a persisted project binding", () => {
    const lookupSession = () => ({
      sessionId: "bound",
      cwd: "/primary",
      workspaceRoot: "/worktree",
      projectId: "p1",
      mainRootId: "r1",
      status: "confirmed" as const,
    });
    const line = JSON.stringify({
      method: "agent/run",
      params: { sessionId: "bound", cwd: "/forged" },
    });

    for (const origin of ["renderer", "mobile"] as const) {
      expect(() =>
        prepareAgentRunMetadata(
          line,
          { origin, producer: `${origin}-test` },
          {
            ...baseDeps(),
            lookupSession,
          },
        ),
      ).toThrow(/does not match persisted Session/);
    }
    const host = prepareAgentRunMetadata(
      line,
      { origin: "host", producer: "panel" },
      {
        ...baseDeps(),
        lookupSession,
      },
    );
    expect(JSON.parse(host.outLine).params).toMatchObject({
      cwd: "/primary",
      projectId: "p1",
      workspaceContext: projectContext,
    });
  });

  test("fails closed with -32602 for derived dir_missing and root_removed Sessions", () => {
    const lookupSession = () => ({
      sessionId: "missing-root-session",
      cwd: "/persisted-old-root",
      workspaceRoot: "/persisted-old-root",
      projectId: "p1",
      mainRootId: "r-old",
      status: "confirmed" as const,
    });
    for (const rootStatus of ["dir_missing", "root_removed"] as const) {
      let caught: unknown;
      try {
        prepareAgentRunMetadata(
          JSON.stringify({
            method: "agent/run",
            params: { sessionId: "missing-root-session" },
          }),
          meta,
          {
            ...baseDeps(),
            lookupSession,
            resolveProjectRun: () => {
              throw new Error(`Session root status ${rootStatus}: repair the Session before run`);
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AgentRunMetadataError);
      expect((caught as AgentRunMetadataError).code).toBe(-32602);
      expect((caught as Error).message).toContain(rootStatus);
    }
  });

  test("new primary gets full context; secondary stays legacy; unknown cwd is rejected", () => {
    const primary = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { sessionId: "p", cwd: "/primary" } }),
      meta,
      baseDeps(),
    );
    expect(JSON.parse(primary.outLine).params.workspaceContext).toEqual(projectContext);

    const secondary = prepareAgentRunMetadata(
      JSON.stringify({ method: "agent/run", params: { sessionId: "s", cwd: "/secondary" } }),
      meta,
      baseDeps(),
    );
    expect(JSON.parse(secondary.outLine).params.workspaceContext).toBeUndefined();
    expect(JSON.parse(secondary.outLine).params.projectId).toBeUndefined();
    expect(() =>
      prepareAgentRunMetadata(
        JSON.stringify({ method: "agent/run", params: { sessionId: "x", cwd: "/unknown" } }),
        meta,
        baseDeps(),
      ),
    ).toThrow(/not authorized/);
  });

  test("credential cwd resolution uses session or persisted cwd and otherwise fails closed", () => {
    expect(resolveCredentialSessionCwd("s1", new Map([["s1", "/repo"]]), () => "/wrong")).toBe(
      "/repo",
    );
    expect(
      resolveCredentialSessionCwd("s2", new Map(), (sid) => (sid === "s2" ? "/saved" : undefined)),
    ).toBe("/saved");
    expect(() => resolveCredentialSessionCwd("s3", new Map(), () => undefined)).toThrow(
      /no cwd registered/,
    );
  });
});
