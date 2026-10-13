import { randomUUID } from "node:crypto";
import type { ToolContext } from "../tool-system/context.js";
import type { CredentialMetadata } from "../credentials/access.js";
import type { OperationReceipt } from "../operations/ledger.js";
import { OperationFailure } from "../operations/controller.js";
import { asRecord } from "./http.js";
import { githubIssueIdentity } from "./github-issue-state.js";
import { boundToolResult } from "../tool-system/bound-tool-result.js";
import { githubOperationPlan, githubRecoveryInput } from "./operation-recovery.js";

export { githubCreateIssueParameters } from "./github-create-issue.js";
import { githubCreateIssueParameters } from "./github-create-issue.js";

export async function verifiedGithubCreateIssue(options: {
  ctx: ToolContext;
  connection: CredentialMetadata;
  params: Record<string, unknown>;
  assertConnected(): void;
  execute(): Promise<unknown>;
}): Promise<{ receipt: OperationReceipt; data: unknown }> {
  const { ctx, connection, assertConnected } = options;
  if (!ctx.operations || !ctx.executeBoundTool) throw new OperationFailure("unsupported");
  if (connection.meta?.linkExecutionBackend === "cli") throw new OperationFailure("unsupported");
  const params = githubCreateIssueParameters(options.params);
  const channel = "link" as const;
  // The model still supplies only ordinary LinkAction parameters. Native custody
  // maps an exact item to a pre-reserved slot or explicitly returns single mode.
  const batch = ctx.operations.batchAuthority
    ? await ctx.operations.batchAuthority("resolve", connection.id, params)
    : undefined;
  const plan = githubOperationPlan(
    ctx.operations.sessionId,
    ctx.originClientMessageId ?? ctx.operations.runId,
    connection,
    "create_issue",
    params,
  );
  if (batch?.kind === "batch") plan.intentVariant = { batchId: batch.batchId, index: batch.index };
  const checkBatch = ctx.operations.batchAuthority
    ? async () => {
        const current = await ctx.operations!.batchAuthority!("check", connection.id, params);
        if (JSON.stringify(current) !== JSON.stringify(batch))
          throw new OperationFailure("permission");
      }
    : undefined;
  const read = async (
    action: "list_issues" | "get_issue",
    readParams: Record<string, unknown>,
  ): Promise<unknown> => {
    assertConnected();
    const execution = await ctx.executeBoundTool!(
      {
        id: `verify-link-${randomUUID()}`,
        toolName: "LinkAction",
        args: { provider: "github", action, connectionId: connection.id, params: readParams },
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
    return output.data;
  };
  let data: unknown;
  let originalIssueIdentity: Record<string, unknown> | undefined;
  const receipt = await ctx.operations.controller.run(plan, {
    recoveryInput: (phase) =>
      phase === "prepared"
        ? githubRecoveryInput(ctx, connection, null)
        : originalIssueIdentity
          ? githubRecoveryInput(ctx, connection, originalIssueIdentity)
          : undefined,
    assertAuthorized: assertConnected,
    checkAuthorized: checkBatch,
    previousVerifiedId: batch?.kind === "batch" ? batch.previousVerifiedId : undefined,
    preflight: async () => {
      if (
        ctx.previewToolPermission?.("LinkAction", {
          provider: "github",
          action: "get_issue",
          connectionId: connection.id,
          params: { owner: params.owner, repo: params.repo },
        }) !== "allow"
      )
        throw new OperationFailure("permission");
      await ctx.operations!.resolver.resolve(
        {
          service: "github",
          intent: "create_issue",
          risk: "write",
          account: connection.meta?.linkAccountId ?? connection.id,
        },
        [
          {
            channel,
            discover: async () => {
              assertConnected();
              return {
                channel,
                account: connection.meta?.linkAccountId ?? connection.id,
                bindingId: connection.id,
                authority: {
                  grant: connection.meta?.linkRemoteGrantId ?? null,
                  capabilities: connection.meta?.linkCapabilityIds ?? null,
                  verifiedAt: connection.meta?.linkLastVerifiedAt ?? null,
                },
              };
            },
          },
        ],
      );
      const capabilities = connection.meta?.linkCapabilityIds;
      if (
        capabilities?.length &&
        ["github.list_issues", "github.get_issue"].some((id) => !capabilities.includes(id))
      )
        throw new OperationFailure("permission");
    },
    validate: async () => {
      const target = asRecord(
        await read("list_issues", { owner: params.owner, repo: params.repo, limit: 1 }),
      );
      if (!Array.isArray(target?.issues)) throw new OperationFailure("validation");
    },
    // The existing native, closed-set write approval has already completed.
    authorize: async () => true,
    execute: async () => {
      data = await options.execute();
      const number = asRecord(data)?.number;
      if (!Number.isSafeInteger(number) || (number as number) <= 0)
        throw new OperationFailure("validation");
      return { id: String(number) };
    },
    verify: async (reference) => {
      if (!/^[1-9][0-9]*$/.test(reference.id) || !Number.isSafeInteger(Number(reference.id)))
        throw new OperationFailure("validation");
      const observed = asRecord(
        await read("get_issue", {
          owner: params.owner,
          repo: params.repo,
          issue_number: Number(reference.id),
        }),
      );
      const identity = githubIssueIdentity(observed, {
        owner: params.owner as string,
        repo: params.repo as string,
        issue_number: Number(reference.id),
      });
      if (identity)
        originalIssueIdentity = { issueId: identity.id, issueNumber: Number(reference.id) };
      return (
        observed?.number === Number(reference.id) &&
        observed.title === params.title &&
        (observed.body ?? "") === (params.body ?? "") &&
        observed.state === "open"
      );
    },
  });
  if (batch?.kind === "batch" && receipt.state !== "verified") {
    // A rejected/uncertain item seals remaining slots immediately in Native custody.
    try {
      await checkBatch?.();
    } catch {
      /* Original non-success receipt remains authoritative. */
    }
  }
  // Replays return only the stored reference, never a fabricated original response.
  return {
    receipt,
    data: data ?? (receipt.reference ? { number: Number(receipt.reference.id) } : null),
  };
}
