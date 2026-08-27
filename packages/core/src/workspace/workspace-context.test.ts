import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceContext,
  legacySingleRootWorkspace,
  removedWorkspaceRootPaths,
  validateWorkspaceContext,
} from "./workspace-context.js";

describe("WorkspaceContext", () => {
  test("creates a deterministic digest independent of root order", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-workspace-context-"));
    const main = join(dir, "main");
    const docs = join(dir, "docs");
    mkdirSync(main);
    mkdirSync(docs);
    try {
      const a = createWorkspaceContext({
        projectId: "project-1",
        projectRevision: 7,
        sessionMainRootId: "root-main",
        roots: [
          { id: "root-main", path: main, role: "primary" },
          { id: "root-docs", path: docs, role: "secondary" },
        ],
      });
      const b = createWorkspaceContext({
        projectId: "project-1",
        projectRevision: 7,
        sessionMainRootId: "root-main",
        roots: [
          { id: "root-docs", path: docs, role: "secondary" },
          { id: "root-main", path: main, role: "primary" },
        ],
      });
      expect(a.rootsDigest).toBe(b.rootsDigest);
      expect(validateWorkspaceContext(a)).toEqual(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects overlapping roots, duplicate ids, invalid primary, and a forged digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-workspace-context-invalid-"));
    const nested = join(dir, "nested");
    mkdirSync(nested);
    try {
      expect(() =>
        createWorkspaceContext({
          projectId: "project-1",
          projectRevision: 1,
          sessionMainRootId: "root-main",
          roots: [
            { id: "root-main", path: dir, role: "primary" },
            { id: "root-nested", path: nested, role: "secondary" },
          ],
        }),
      ).toThrow("overlap");
      expect(() =>
        createWorkspaceContext({
          projectId: "project-1",
          projectRevision: 1,
          sessionMainRootId: "root-main",
          roots: [
            { id: "root-main", path: dir, role: "primary" },
            { id: "root-main", path: join(tmpdir(), "elsewhere"), role: "secondary" },
          ],
        }),
      ).toThrow("duplicate root id");
      expect(() =>
        createWorkspaceContext({
          projectId: "project-1",
          projectRevision: 1,
          sessionMainRootId: "missing",
          roots: [{ id: "root-main", path: dir, role: "primary" }],
        }),
      ).toThrow("sessionMainRootId");
      const valid = legacySingleRootWorkspace(dir);
      expect(() => validateWorkspaceContext({ ...valid, rootsDigest: "forged" })).toThrow(
        "rootsDigest",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("identifies only roots removed from the next immutable context", () => {
    const previous = {
      ...legacySingleRootWorkspace("/tmp/main"),
      roots: [
        { id: "main", path: "/tmp/main", role: "primary" as const },
        { id: "docs", path: "/tmp/docs", role: "secondary" as const },
      ],
      sessionMainRootId: "main",
    };
    const next = {
      ...legacySingleRootWorkspace("/tmp/main"),
      roots: [{ id: "main", path: "/tmp/main", role: "primary" as const }],
      sessionMainRootId: "main",
    };
    expect(removedWorkspaceRootPaths(previous, next)).toEqual(["/tmp/docs"]);
  });
});
