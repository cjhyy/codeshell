import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireRendererProjectPrimary } from "./renderer-project-path.js";
import {
  getSessionWorkspaceAuthorityForUi,
  requireUsableSessionRootAuthority,
  type SessionWorkspaceAuthority,
} from "./session-workspace-service.js";

export type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";

export type ResolvedRendererConfigurationTarget =
  | {
      kind: "project";
      projectId: string;
      mainRootId: string;
      cwd: string;
    }
  | {
      kind: "session";
      projectId: string | null;
      sessionId: string;
      mainRootId: string | null;
      cwd: string;
    }
  | { kind: "no-repo"; cwd: string };

interface RendererConfigurationAuthorityDeps {
  resolveProjectPrimary: typeof requireRendererProjectPrimary;
  resolveSessionAuthority: (sessionId: string) => Promise<SessionWorkspaceAuthority>;
  requireUsableSessionAuthority: typeof requireUsableSessionRootAuthority;
  resolveNoRepoCwd: () => string;
}

const defaultDeps: RendererConfigurationAuthorityDeps = {
  resolveProjectPrimary: requireRendererProjectPrimary,
  resolveSessionAuthority: getSessionWorkspaceAuthorityForUi,
  requireUsableSessionAuthority: requireUsableSessionRootAuthority,
  resolveNoRepoCwd: () => {
    const cwd = join(homedir(), ".code-shell", "no-repo");
    mkdirSync(cwd, { recursive: true });
    return cwd;
  },
};

function assertSessionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error("invalid configuration sessionId");
  }
}

/**
 * Resolve renderer-visible configuration authority without ever accepting a
 * caller-supplied path. Objects are exact: adding cwd/rootId or mixing stable
 * identities fails closed instead of being silently ignored.
 */
export async function resolveRendererConfigurationTarget(
  input: unknown,
  deps: RendererConfigurationAuthorityDeps = defaultDeps,
): Promise<ResolvedRendererConfigurationTarget> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("configuration target must be a stable identity object");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) throw new Error("configuration target must contain exactly one identity");

  if (keys[0] === "projectId") {
    const resolved = await deps.resolveProjectPrimary(record.projectId);
    return {
      kind: "project",
      projectId: resolved.project.id,
      mainRootId: resolved.rootId,
      cwd: resolved.path,
    };
  }
  if (keys[0] === "sessionId") {
    assertSessionId(record.sessionId);
    const authority = await deps.resolveSessionAuthority(record.sessionId);
    deps.requireUsableSessionAuthority(authority);
    return {
      kind: "session",
      projectId: authority.projectId,
      sessionId: record.sessionId,
      mainRootId: authority.mainRootId,
      cwd: authority.mainRoot,
    };
  }
  if (keys[0] === "noRepo" && record.noRepo === true) {
    return { kind: "no-repo", cwd: deps.resolveNoRepoCwd() };
  }
  throw new Error("configuration target requires projectId, sessionId, or noRepo");
}
