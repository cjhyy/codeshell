import { randomUUID } from "node:crypto";
import type { ToolContext } from "../tool-system/context.js";
import type { CredentialMetadata } from "../credentials/access.js";
import type { OperationReceipt } from "../operations/ledger.js";
import { OperationFailure } from "../operations/controller.js";
import { boundToolResult } from "../tool-system/bound-tool-result.js";
import { githubOperationPlan, githubRecoveryInput } from "./operation-recovery.js";
import { asRecord } from "./http.js";
import {
  githubIssueIdentity,
  githubIssueStateActionIds,
  githubIssueStateParameters,
} from "./github-issue-state.js";

/** Fixed desired-state semantics; even a no-op receives an independent read receipt. */
export async function verifiedGithubUpdateIssue(options: {
  ctx: ToolContext;
  connection: CredentialMetadata;
  params: Record<string, unknown>;
  assertConnected(): void;
  execute(): Promise<unknown>;
}): Promise<{ receipt: OperationReceipt; data: unknown }> {
  const { ctx, connection, assertConnected } = options;
  if (!ctx.operations || !ctx.executeBoundTool) throw new OperationFailure("unsupported");
  if (connection.meta?.linkExecutionBackend === "cli") throw new OperationFailure("unsupported");
  const params = githubIssueStateParameters(options.params);
  const repositoryTarget = { owner: params.owner, repo: params.repo };
  const target = { ...repositoryTarget, issue_number: params.issue_number };
  const channel = "link" as const;
  const read = async (action: "get_repository" | "get_issue") => {
    assertConnected();
    const execution = await ctx.executeBoundTool!(
      {
        id: `verify-issue-state-${randomUUID()}`,
        toolName: "LinkAction",
        args: {
          provider: "github",
          action,
          connectionId: connection.id,
          params: action === "get_repository" ? repositoryTarget : target,
        },
      },
      { signal: ctx.signal, assertAuthorized: assertConnected },
    );
    assertConnected();
    const result = boundToolResult(execution);
    if (result.isError || typeof result.result !== "string")
      throw new OperationFailure("permission");
    const output = asRecord(JSON.parse(result.result));
    if (
      output?.kind !== "action_result" ||
      output.provider !== "github" ||
      output.action !== action ||
      output.connectionId !== connection.id
    )
      throw new OperationFailure("permission");
    return asRecord(output.data);
  };
  let alreadySatisfied = false;
  let repositoryId: number | undefined;
  let issueId: number | undefined;
  const receipt = await ctx.operations.controller.run(
    githubOperationPlan(
      ctx.operations.sessionId,
      ctx.originClientMessageId ?? ctx.operations.runId,
      connection,
      "update_issue",
      params,
    ),
    {
      recoveryInput: (phase) =>
        phase === "prepared"
          ? githubRecoveryInput(ctx, connection, { repositoryId: repositoryId!, issueId: issueId! })
          : undefined,
      assertAuthorized: assertConnected,
      preflight: async () => {
        if (
          !connection.meta?.linkAccountId ||
          !connection.meta.linkLastVerifiedAt ||
          githubIssueStateActionIds.some(
            (action) => !connection.meta?.linkCapabilityIds?.includes(`github.${action}`),
          )
        )
          throw new OperationFailure("permission");
        for (const action of ["get_repository", "get_issue"]) {
          if (
            ctx.previewToolPermission?.("LinkAction", {
              provider: "github",
              action,
              connectionId: connection.id,
              params: action === "get_repository" ? repositoryTarget : target,
            }) !== "allow"
          )
            throw new OperationFailure("permission");
        }
        await ctx.operations!.resolver.resolve(
          {
            service: "github",
            intent: "update_issue",
            risk: "write",
            account: connection.meta.linkAccountId,
          },
          [
            {
              channel,
              discover: async () => {
                assertConnected();
                return {
                  channel,
                  account: connection.meta!.linkAccountId!,
                  bindingId: connection.id,
                  authority: {
                    grant: connection.meta?.linkRemoteGrantId ?? null,
                    capabilities: connection.meta?.linkCapabilityIds,
                    verifiedAt: connection.meta?.linkLastVerifiedAt,
                  },
                };
              },
            },
          ],
        );
      },
      validate: async () => {
        const repository = await read("get_repository");
        if (
          !Number.isSafeInteger(repository?.id) ||
          (repository!.id as number) <= 0 ||
          typeof repository?.full_name !== "string" ||
          repository.full_name.toLowerCase() !== `${params.owner}/${params.repo}`
        )
          throw new OperationFailure("validation");
        repositoryId = repository!.id as number;
        const issue = githubIssueIdentity(await read("get_issue"), target);
        if (!issue) throw new OperationFailure("validation");
        issueId = issue.id;
        alreadySatisfied = issue.state === params.state;
      },
      // Exact closed-set native approval is completed by LinkAction before this adapter.
      authorize: async () => true,
      execute: async () => {
        if (!repositoryId || !issueId) throw new OperationFailure("validation");
        if (!alreadySatisfied) await options.execute();
        return {
          id: `${repositoryId}/${issueId}/${params.issue_number}/${params.state}/${alreadySatisfied ? "unchanged" : "changed"}`,
        };
      },
      verify: async (reference) => {
        const match = reference.id.match(
          new RegExp(
            `^([1-9][0-9]*)/([1-9][0-9]*)/${params.issue_number}/${params.state}/(?:changed|unchanged)$`,
          ),
        );
        if (!match || ![match[1], match[2]].every((id) => Number.isSafeInteger(Number(id))))
          throw new OperationFailure("validation");
        // Persisted identity survives restart; a reused repository name cannot
        // establish the original target's postcondition after a rename/recreate.
        const observed = await read("get_repository");
        if (
          observed?.id !== Number(match[1]) ||
          typeof observed.full_name !== "string" ||
          observed.full_name.toLowerCase() !== `${params.owner}/${params.repo}`
        )
          return false;
        const issue = githubIssueIdentity(await read("get_issue"), target);
        return issue?.id === Number(match[2]) && issue.state === params.state;
      },
    },
  );
  return {
    receipt,
    data:
      receipt.state === "verified"
        ? {
            ...target,
            state: params.state,
            changed: receipt.reference?.id.endsWith("/changed") === true,
            verified: true,
          }
        : { ...target, desiredState: params.state, verified: false },
  };
}
