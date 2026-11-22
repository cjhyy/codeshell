import type { ExternalGitBlobRef } from "@cjhyy/code-shell-core";
import { isDeepStrictEqual } from "node:util";
import type { ListSessions } from "../../shared/disk-session-query.js";
import { isDesktopSessionId } from "../../shared/disk-session-query.js";
import type { ReviewAiPromptRequest, ReviewGitDiffRequest } from "../../shared/review.js";
import type { FileRoot } from "../../shared/workspace-read-contracts.js";
import { fileExists, readDirectory, readFile } from "../fs-service.js";
import { searchProjectFiles } from "../file-search-service.js";
import { readGitBlobVersion } from "../file-version-service.js";
import { getGitBranches, getGitStatus } from "../git-services.js";
import { requireMountedProjectRoot } from "../mounted-project-root.js";
import {
  requireRendererProject,
  requireRendererProjectPrimary,
  requireRendererProjectRoot,
} from "../renderer-project-path.js";
import { listProfiles } from "../profiles-service.js";
import { ReviewService } from "../review-service.js";
import {
  getSessionWorkspaceAuthorityForUi,
  getSessionWorktreeDiffForUi,
  listSessionWorktreesForUi,
  requireUsableSessionRootAuthority,
  requireSessionFileRootForUi,
  resolveSessionReviewWorkspaceForUi,
} from "../session-workspace-service.js";
import { HostRevokedError, type HostRequestContext } from "./authority.js";
import {
  businessArguments,
  businessRead,
  scopedBusinessRead,
  textArgument,
} from "./business-read.js";
import { InvalidParams } from "./server.js";

function sessionId(value: unknown) {
  if (!isDesktopSessionId(value)) throw new InvalidParams("A session id is required");
  return value;
}
function fileRoot(input: Record<string, unknown>): FileRoot {
  const value = businessArguments(input.owner, ["sessionId", "projectId"]);
  if (Object.keys(value).length !== 1) throw new InvalidParams("Expected one file owner");
  const owner =
    "sessionId" in value
      ? { sessionId: sessionId(value.sessionId) }
      : { projectId: textArgument(value.projectId) };
  return { owner, rootId: textArgument(input.rootId) };
}
function filePath(input: unknown) {
  const args = businessArguments(input, ["owner", "rootId", "path"]);
  return { ...fileRoot(args), path: textArgument(args.path) };
}
const sessionScope = (input: { sessionId: string }) => input.sessionId;
const fileScope = ({ owner }: FileRoot) => ("sessionId" in owner ? owner.sessionId : undefined);
const project = (input: unknown) => ({
  projectId: textArgument(businessArguments(input, ["projectId"]).projectId),
});
const session = (input: unknown) => ({
  sessionId: sessionId(businessArguments(input, ["sessionId"]).sessionId),
});

/** Discard reads if the registered mount, project revision or session workspace
 * changed while filesystem or git I/O was outstanding. */
export async function readCurrentWorkspace<T, R>(
  lookup: () => Promise<T>,
  ctx: HostRequestContext,
  read: (authority: T) => Promise<R>,
) {
  const before = await lookup();
  ctx.assertCurrent();
  const result = await read(before);
  if (!isDeepStrictEqual(before, await lookup())) throw new HostRevokedError();
  ctx.assertCurrent();
  return result;
}

async function resolveFileRoot({ owner, rootId }: FileRoot) {
  if ("projectId" in owner) {
    const mount = await requireRendererProjectRoot(owner.projectId, rootId);
    return { path: mount.path, projectId: mount.project.id, revision: mount.project.revision };
  }
  const path = await requireSessionFileRootForUi(owner.sessionId, rootId);
  const { projectId } = await getSessionWorkspaceAuthorityForUi(owner.sessionId);
  return {
    path,
    projectId,
    revision: projectId ? (await requireRendererProject(projectId)).revision : null,
  };
}
function atFileRoot<R>(
  root: FileRoot,
  ctx: HostRequestContext,
  read: (root: string) => Promise<R>,
) {
  return readCurrentWorkspace(
    () => resolveFileRoot(root),
    ctx,
    ({ path }) => read(path),
  );
}
function atPrimary<R>(id: string, ctx: HostRequestContext, read: (root: string) => Promise<R>) {
  return readCurrentWorkspace(
    async () => {
      const { project, rootId, path } = await requireRendererProjectPrimary(id);
      return { revision: project.revision, rootId, path };
    },
    ctx,
    ({ path }) => read(path),
  );
}
function review<R>(
  id: string,
  ctx: HostRequestContext,
  read: (service: ReviewService) => Promise<R>,
) {
  return readCurrentWorkspace(
    async () => {
      const workspace = await resolveSessionReviewWorkspaceForUi(id);
      const revision = workspace.projectId
        ? (await requireRendererProject(workspace.projectId)).revision
        : null;
      return { workspace, revision };
    },
    ctx,
    ({ workspace }) => read(new ReviewService({ resolveWorkspace: async () => workspace })),
  );
}

export function workspaceReads(list: ListSessions, trackGitRoot: (root: string) => void) {
  async function atSessionRoot<T>(
    id: string,
    ctx: HostRequestContext,
    read: (root: string) => Promise<T> | T,
    track = false,
  ) {
    const resolved = await readCurrentWorkspace(
      async () => {
        const authority = await getSessionWorkspaceAuthorityForUi(id);
        requireUsableSessionRootAuthority(authority);
        const revision = authority.projectId
          ? (await requireRendererProject(authority.projectId)).revision
          : null;
        return { authority, revision };
      },
      ctx,
      async ({ authority }) => ({
        root: authority.mainRoot,
        value: await read(authority.mainRoot),
      }),
    );
    if (track) trackGitRoot(resolved.root);
    return resolved.value;
  }
  return [
    scopedBusinessRead(
      "files/list",
      list,
      (input) => {
        const args = businessArguments(input, ["owner", "rootId", "dir"]);
        return {
          ...fileRoot(args),
          dir: args.dir === undefined || args.dir === "" ? undefined : textArgument(args.dir),
        };
      },
      fileScope,
      (input, ctx) => atFileRoot(input, ctx, (root) => readDirectory(root, input.dir ?? root)),
    ),
    scopedBusinessRead("files/read", list, filePath, fileScope, (input, ctx) =>
      atFileRoot(input, ctx, (root) => readFile(root, input.path)),
    ),
    scopedBusinessRead("files/exists", list, filePath, fileScope, async (input, ctx) => {
      try {
        return await atFileRoot(input, ctx, (root) => fileExists(root, input.path));
      } catch (error) {
        if (error instanceof HostRevokedError) throw error;
        return false;
      }
    }),
    scopedBusinessRead(
      "files/version",
      list,
      (input) => {
        const args = businessArguments(input, ["owner", "rootId", "ref"]);
        return { ...fileRoot(args), ref: args.ref as ExternalGitBlobRef };
      },
      fileScope,
      (input, ctx) => atFileRoot(input, ctx, (root) => readGitBlobVersion(root, input.ref)),
    ),
    businessRead(
      "files/searchProject",
      (input) => {
        const args = businessArguments(input, ["projectId", "query", "rootId"]);
        if (typeof args.query !== "string" || args.query.length > 512) throw new InvalidParams();
        return {
          projectId: textArgument(args.projectId),
          query: args.query,
          rootId: args.rootId === undefined ? undefined : textArgument(args.rootId),
        };
      },
      ({ projectId, rootId, query }, ctx) =>
        readCurrentWorkspace(
          async () => {
            const p = await requireRendererProject(projectId);
            const roots = (rootId ? p.roots.filter((r) => r.id === rootId) : p.roots).map((r) => ({
              id: r.id,
              path: requireMountedProjectRoot(r),
            }));
            if (rootId && !roots.length) throw new Error("Project root not found");
            return { revision: p.revision, roots };
          },
          ctx,
          ({ roots }) => searchProjectFiles(roots, query),
        ),
    ),
    businessRead("git/projectStatus", project, ({ projectId }, ctx) =>
      atPrimary(projectId, ctx, getGitStatus),
    ),
    businessRead("git/projectBranches", project, ({ projectId }, ctx) =>
      atPrimary(projectId, ctx, getGitBranches),
    ),
    scopedBusinessRead("workspace/gitStatus", list, session, sessionScope, ({ sessionId }, ctx) =>
      atSessionRoot(sessionId, ctx, getGitStatus, true),
    ),
    scopedBusinessRead("workspace/gitBranches", list, session, sessionScope, ({ sessionId }, ctx) =>
      atSessionRoot(sessionId, ctx, getGitBranches, true),
    ),
    scopedBusinessRead("workspace/profiles", list, session, sessionScope, ({ sessionId }, ctx) =>
      atSessionRoot(sessionId, ctx, listProfiles),
    ),
    scopedBusinessRead(
      "workspace/list",
      list,
      (raw) => {
        const args = businessArguments(raw, ["sessionId", "cwd"]);
        return { sessionId: sessionId(args.sessionId), cwd: textArgument(args.cwd) };
      },
      sessionScope,
      ({ sessionId }, ctx) =>
        atSessionRoot(sessionId, ctx, (root) => listSessionWorktreesForUi(sessionId, root), true),
    ),
    scopedBusinessRead(
      "workspace/diff",
      list,
      (raw) => {
        const args = businessArguments(raw, ["sessionId", "worktreePath"]);
        return {
          sessionId: sessionId(args.sessionId),
          worktreePath: textArgument(args.worktreePath),
        };
      },
      sessionScope,
      ({ sessionId, worktreePath }, ctx) =>
        atSessionRoot(sessionId, ctx, () => getSessionWorktreeDiffForUi(sessionId, worktreePath)),
    ),
    scopedBusinessRead("review/status", list, session, sessionScope, ({ sessionId }, ctx) =>
      review(sessionId, ctx, (s) => s.getStatus(sessionId)),
    ),
    scopedBusinessRead(
      "review/diff",
      list,
      (input) => {
        const args = businessArguments(input, ["sessionId", "request"]);
        return {
          sessionId: sessionId(args.sessionId),
          request: args.request as ReviewGitDiffRequest,
        };
      },
      sessionScope,
      ({ sessionId, request }, ctx) => review(sessionId, ctx, (s) => s.getDiff(sessionId, request)),
    ),
    scopedBusinessRead(
      "review/prompt",
      list,
      (input) => {
        const args = businessArguments(input, ["sessionId", "request"]);
        return {
          sessionId: sessionId(args.sessionId),
          request: args.request as ReviewAiPromptRequest,
        };
      },
      sessionScope,
      ({ sessionId, request }, ctx) =>
        review(sessionId, ctx, (s) => s.preparePrompt(sessionId, request)),
    ),
    scopedBusinessRead(
      "review/commits",
      list,
      (input) => {
        const args = businessArguments(input, ["sessionId", "limit"]);
        if (args.limit !== undefined && typeof args.limit !== "number") throw new InvalidParams();
        return { sessionId: sessionId(args.sessionId), limit: args.limit };
      },
      sessionScope,
      ({ sessionId, limit }, ctx) =>
        review(sessionId, ctx, (s) => s.getRecentCommits(sessionId, limit)),
    ),
  ];
}
