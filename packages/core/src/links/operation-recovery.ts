import type { CredentialMetadata } from "../credentials/access.js";
import type { OperationPlan } from "../operations/ledger.js";
import type { ToolContext } from "../tool-system/context.js";
import { linkAuthoritySnapshot } from "./authority.js";

export type ReviewedGithubWrite = "create_issue" | "set_starred" | "update_issue";

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
  return {
    sessionId,
    intentId: `${originIntent}:github.${action}`,
    service: "github",
    action,
    channel: connection.meta?.linkExecutionRuntime === "server" ? "remote-link" : "local-link",
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
      settingsScope: ctx.settingsScope ?? "project",
      permissionMode: ctx.permissionMode ?? "default",
      planMode: ctx.planMode ?? false,
      linkActionEnabled: !ctx.disabledBuiltins?.has("LinkAction"),
      linkActionAllowed: !ctx.allowedToolNames || ctx.allowedToolNames.has("LinkAction"),
    },
    identity,
  };
}
