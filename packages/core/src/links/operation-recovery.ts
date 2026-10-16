import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import type { CredentialMetadata } from "../credentials/access.js";
import type { OperationPlan, OperationConflictScopeResolver } from "../operations/ledger.js";
import type { ToolContext } from "../tool-system/context.js";
import { linkAuthoritySnapshot } from "./authority.js";

export type ReviewedGithubWrite = "create_issue" | "set_starred" | "update_issue";

/** GitHub repository names are case-insensitive. All reviewed writes fence their parent repo. */
export const GITHUB_OPERATION_CONFLICT_SCOPE: OperationConflictScopeResolver = {
  format: "github-repository-v1",
  resolveTarget(plan) {
    if (plan.service !== "github") return undefined;
    const explicit = plan.conflictScope?.target;
    const repository =
      explicit && typeof explicit === "object" && !Array.isArray(explicit)
        ? (explicit as Record<string, unknown>).repository
        : undefined;
    if (
      typeof repository === "string" &&
      /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repository) &&
      ![".", ".."].includes(repository.split("/")[1]!)
    )
      return { repository: repository.toLowerCase() };
    const target =
      plan.target && typeof plan.target === "object" && !Array.isArray(plan.target)
        ? (plan.target as Record<string, unknown>)
        : undefined;
    const owner = target?.owner;
    const repo = target?.repo;
    if (
      typeof owner !== "string" ||
      typeof repo !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) ||
      !/^[a-z0-9_.-]{1,100}$/i.test(repo) ||
      [".", ".."].includes(repo)
    )
      return undefined;
    return { repository: `${owner}/${repo}`.toLowerCase() };
  },
};

/** Shared immutable plan construction for live writes and exact legacy proof. */
export function githubOperationPlan(
  sessionId: string,
  originIntent: string,
  connection: CredentialMetadata,
  action: ReviewedGithubWrite,
  params: Record<string, unknown>,
): OperationPlan {
  const target = {
    owner: params.owner,
    repo: params.repo,
    ...(action === "update_issue" ? { issue_number: params.issue_number } : {}),
  };
  const plan: OperationPlan = {
    sessionId,
    intentId: `${originIntent}:github.${action}`,
    service: "github",
    action,
    channel:
      linkConnectionMetadata(connection.meta).linkExecutionRuntime === "server"
        ? "remote-link"
        : "local-link",
    account: {
      id: connection.meta?.linkAccountId ?? null,
      connectionId: connection.id,
      grant: connection.meta?.linkRemoteGrantId ?? null,
      verifiedAt: connection.meta?.linkLastVerifiedAt ?? null,
    },
    target,
    parameters: params,
    postcondition:
      action === "create_issue"
        ? {
            kind: "github.issue.matches",
            title: params.title,
            body: params.body ?? "",
            state: "open",
          }
        : action === "set_starred"
          ? { kind: "github.repository.starred", starred: params.starred }
          : { kind: "github.issue.state", state: params.state },
  };
  return {
    ...plan,
    conflictScope: {
      format: GITHUB_OPERATION_CONFLICT_SCOPE.format,
      target: GITHUB_OPERATION_CONFLICT_SCOPE.resolveTarget(plan) ?? null,
    },
  };
}

/** Original Host tool context, without secret material or model-supplied policy. */
export function githubRecoveryInput(
  ctx: ToolContext,
  connection: CredentialMetadata,
  identity: Record<string, unknown> | null,
) {
  return {
    schema: 1 as const,
    authority: linkAuthoritySnapshot(connection),
    policy: {
      workspaceProfileName: ctx.workspaceProfileName ?? null,
      settingsScope: ctx.settingsScope ?? "full",
      permissionMode: ctx.permissionMode ?? "default",
      planMode: ctx.planMode ?? false,
      linkActionEnabled: !ctx.disabledBuiltins?.has("LinkAction"),
      linkActionAllowed: !ctx.allowedToolNames || ctx.allowedToolNames.has("LinkAction"),
    },
    identity,
  };
}
