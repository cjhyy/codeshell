import { describe, expect, test } from "bun:test";
import {
  resolveAutomationCreateAuthority,
  resolveAutomationUpdateAuthority,
  validateAutomationResumeAuthority,
} from "./automation-authority.js";

function deps(
  session: {
    cwd: string;
    workspaceCwd?: string;
    projectId?: string;
    rootId?: string;
  } | null = {
    cwd: "/primary",
    projectId: "project-1",
    rootId: "root-primary",
  },
) {
  return {
    requireRendererPath: async (cwd: string) => cwd,
    isNoRepoCwd: (cwd: string) => cwd === "/no-repo",
    resolveProjectRootById: (projectId: string, rootId?: string) => {
      if (projectId !== "project-1") throw new Error("project not found");
      if (rootId === "foreign") throw new Error("project root not found");
      const resolvedRootId = rootId ?? "root-primary";
      return {
        projectId,
        rootId: resolvedRootId,
        cwd: resolvedRootId === "root-secondary" ? "/secondary" : "/primary",
      };
    },
    resolveExactRoot: (cwd: string) =>
      cwd === "/primary"
        ? { projectId: "project-1", rootId: "root-primary", cwd: "/primary" }
        : undefined,
    resolveSessionAuthority: async (sessionId: string) =>
      sessionId === "session-1" && session ? { sessionId, ...session } : undefined,
  };
}

describe("automation Main workspace authority", () => {
  test("new V2 jobs default to the current primary and reject renderer path mismatches", async () => {
    await expect(
      resolveAutomationCreateAuthority({ projectId: "project-1" }, deps()),
    ).resolves.toEqual({
      projectId: "project-1",
      rootId: "root-primary",
      cwd: "/primary",
    });
    await expect(
      resolveAutomationCreateAuthority(
        { projectId: "project-1", rootId: "root-secondary", cwd: "/forged" },
        deps(),
      ),
    ).rejects.toThrow(/does not match/i);
    await expect(
      resolveAutomationCreateAuthority(
        { projectId: "project-1", rootId: "foreign", cwd: "/primary" },
        deps(),
      ),
    ).rejects.toThrow(/root not found/);
  });

  test("new cwd input is upgraded when mounted while only existing jobs keep legacy cwd", async () => {
    await expect(resolveAutomationCreateAuthority({ cwd: "/primary" }, deps())).resolves.toEqual({
      projectId: "project-1",
      rootId: "root-primary",
      cwd: "/primary",
    });
    await expect(resolveAutomationCreateAuthority({ cwd: "/legacy" }, deps())).rejects.toThrow(
      /explicit projectId\/rootId authority/,
    );
    await expect(resolveAutomationUpdateAuthority({}, { cwd: "/legacy" }, deps())).resolves.toEqual(
      { cwd: "/legacy" },
    );
  });

  test("updates atomically rebind ids or explicitly clear to no-repo", async () => {
    await expect(
      resolveAutomationUpdateAuthority(
        { projectId: "project-1", rootId: "root-secondary" },
        { cwd: "/primary", projectId: "project-1", rootId: "root-primary" },
        deps(),
      ),
    ).resolves.toEqual({
      projectId: "project-1",
      rootId: "root-secondary",
      cwd: "/secondary",
    });
    await expect(
      resolveAutomationUpdateAuthority(
        { projectId: null, rootId: null, cwd: "" },
        { cwd: "/primary", projectId: "project-1", rootId: "root-primary" },
        deps(),
      ),
    ).resolves.toEqual({ projectId: null, rootId: null, cwd: "" });
  });

  test("resume creation derives stable ids from durable Session authority", async () => {
    await expect(
      resolveAutomationCreateAuthority({ resumeSessionId: "session-1" }, deps()),
    ).resolves.toEqual({
      cwd: "/primary",
      projectId: "project-1",
      rootId: "root-primary",
    });
  });

  test("resume creation rejects cross-project, same-project different-root, and forged cwd", async () => {
    await expect(
      resolveAutomationCreateAuthority(
        {
          resumeSessionId: "session-1",
          projectId: "project-2",
          rootId: "root-primary",
        },
        deps(),
      ),
    ).rejects.toThrow(/Session.*project/i);
    await expect(
      resolveAutomationCreateAuthority(
        {
          resumeSessionId: "session-1",
          projectId: "project-1",
          rootId: "root-secondary",
        },
        deps(),
      ),
    ).rejects.toThrow(/Session.*root/i);
    await expect(
      resolveAutomationCreateAuthority({ resumeSessionId: "session-1", cwd: "/secondary" }, deps()),
    ).rejects.toThrow(/Session.*cwd/i);
  });

  test("resume update cannot switch Session and re-normalizes to a migrated Session root", async () => {
    const migrated = deps({
      cwd: "/secondary",
      projectId: "project-1",
      rootId: "root-secondary",
    });
    const existing = {
      cwd: "/primary",
      projectId: "project-1",
      rootId: "root-primary",
      resumeSessionId: "session-1",
    };
    await expect(resolveAutomationUpdateAuthority({}, existing, migrated)).resolves.toEqual({
      cwd: "/secondary",
      projectId: "project-1",
      rootId: "root-secondary",
    });
    await expect(
      resolveAutomationUpdateAuthority({ resumeSessionId: "session-2" }, existing, migrated),
    ).rejects.toThrow(/resume Session.*immutable/i);
    await expect(
      resolveAutomationUpdateAuthority(
        { projectId: "project-1", rootId: "root-primary" },
        existing,
        migrated,
      ),
    ).rejects.toThrow(/Session.*root/i);
  });

  test("no-repo resume remains explicit while missing or unbound resume Sessions reject", async () => {
    await expect(
      resolveAutomationCreateAuthority({ resumeSessionId: "session-1" }, deps({ cwd: "/no-repo" })),
    ).resolves.toEqual({ cwd: "", projectId: null, rootId: null });
    await expect(
      resolveAutomationCreateAuthority({ resumeSessionId: "missing" }, deps()),
    ).rejects.toThrow(/resume Session.*missing/i);
    await expect(
      resolveAutomationCreateAuthority({ resumeSessionId: "session-1" }, deps({ cwd: "/legacy" })),
    ).rejects.toThrow(/stable project root binding/i);
  });

  test("creator authority errors identify the creator Session and discourage ineffective retries", async () => {
    await expect(
      resolveAutomationCreateAuthority(
        { authoritySessionId: "session-1", cwd: "/legacy" },
        deps({ cwd: "/legacy" }),
      ),
    ).rejects.toThrow(/creator Session.*changing cwd or switching workspace cannot repair it/i);
  });

  test("trigger validation rereads Session authority and fails closed after migration", async () => {
    const job = {
      cwd: "/primary",
      projectId: "project-1",
      rootId: "root-primary",
      resumeSessionId: "session-1",
    };
    await expect(validateAutomationResumeAuthority(job, deps())).resolves.toEqual({
      ok: true,
      authority: { cwd: "/primary", projectId: "project-1", rootId: "root-primary" },
    });
    await expect(
      validateAutomationResumeAuthority(
        job,
        deps({
          cwd: "/secondary",
          projectId: "project-1",
          rootId: "root-secondary",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/root.*changed/i) });
  });

  test("trigger validation permits explicit no-repo and only matching cwd-only legacy jobs", async () => {
    await expect(
      validateAutomationResumeAuthority(
        { cwd: "", resumeSessionId: "session-1" },
        deps({ cwd: "/no-repo" }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateAutomationResumeAuthority(
        { cwd: "/legacy", resumeSessionId: "session-1" },
        deps({ cwd: "/legacy" }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateAutomationResumeAuthority(
        { cwd: "/other", resumeSessionId: "session-1" },
        deps({ cwd: "/legacy" }),
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  test("root removed or missing rejects creation and permanently stops triggering", async () => {
    const unavailable = {
      ...deps(),
      resolveProjectRootById: () => {
        throw new Error("project root directory is missing");
      },
    };
    await expect(
      resolveAutomationCreateAuthority({ resumeSessionId: "session-1" }, unavailable),
    ).rejects.toThrow(/directory is missing/);
    await expect(
      validateAutomationResumeAuthority(
        {
          cwd: "/primary",
          projectId: "project-1",
          rootId: "root-primary",
          resumeSessionId: "session-1",
        },
        unavailable,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/root is unavailable.*directory is missing/i),
    });
  });
});
