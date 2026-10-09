import { randomUUID } from "node:crypto";
import type { ToolContext } from "../tool-system/context.js";
import type { CredentialMetadata } from "../credentials/access.js";
import type { OperationReceipt } from "../operations/ledger.js";
import { OperationFailure } from "../operations/controller.js";
import { boundToolResult } from "../tool-system/bound-tool-result.js";
import { githubOperationPlan, githubRecoveryInput } from "./operation-recovery.js";
import { asRecord } from "./http.js";
import { githubSetStarredParameters } from "./github-star.js";

/** Fixed desired-state semantics; even a no-op receives an independent read receipt. */
export async function verifiedGithubSetStarred(options: {
  ctx: ToolContext;
  connection: CredentialMetadata;
  params: Record<string, unknown>;
  assertConnected(): void;
  execute(): Promise<unknown>;
}): Promise<{ receipt: OperationReceipt; data: unknown }> {
  const { ctx, connection, assertConnected } = options;
  if (!ctx.operations || !ctx.executeBoundTool) throw new OperationFailure("unsupported");
  if (connection.meta?.linkExecutionBackend === "cli") throw new OperationFailure("unsupported");
  const params = githubSetStarredParameters(options.params);
  const target = { owner: params.owner, repo: params.repo };
  const channel = "link" as const;
  const read = async (action: "get_repository" | "get_starred") => {
    assertConnected();
    const execution = await ctx.executeBoundTool!(
      {
        id: `verify-star-${randomUUID()}`,
        toolName: "LinkAction",
        args: { provider: "github", action, connectionId: connection.id, params: target },
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
  const receipt = await ctx.operations.controller.run(
    githubOperationPlan(
      ctx.operations.sessionId,
      ctx.originClientMessageId ?? ctx.operations.runId,
      connection,
      "set_starred",
      params,
    ),
    {
      recoveryInput: (phase) =>
        phase === "prepared"
          ? githubRecoveryInput(ctx, connection, { repositoryId: repositoryId! })
          : undefined,
      assertAuthorized: assertConnected,
      preflight: async () => {
        if (
          !connection.meta?.linkAccountId ||
          !connection.meta.linkLastVerifiedAt ||
          ["get_repository", "get_starred", "set_starred"].some(
            (action) => !connection.meta?.linkCapabilityIds?.includes(`github.${action}`),
          )
        )
          throw new OperationFailure("permission");
        for (const action of ["get_repository", "get_starred"]) {
          if (
            ctx.previewToolPermission?.("LinkAction", {
              provider: "github",
              action,
              connectionId: connection.id,
              params: target,
            }) !== "allow"
          )
            throw new OperationFailure("permission");
        }
        await ctx.operations!.resolver.resolve(
          {
            service: "github",
            intent: "set_starred",
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
        const state = await read("get_starred");
        if (typeof state?.starred !== "boolean") throw new OperationFailure("validation");
        alreadySatisfied = state.starred === params.starred;
      },
      // Exact closed-set native approval is completed by LinkAction before this adapter.
      authorize: async () => true,
      execute: async () => {
        if (!repositoryId) throw new OperationFailure("validation");
        if (!alreadySatisfied) await options.execute();
        return {
          id: `${repositoryId}/${params.starred ? "starred" : "unstarred"}/${alreadySatisfied ? "unchanged" : "changed"}`,
        };
      },
      verify: async (reference) => {
        const match = reference.id.match(
          new RegExp(
            `^([1-9][0-9]*)/${params.starred ? "starred" : "unstarred"}/(?:changed|unchanged)$`,
          ),
        );
        if (!match || !Number.isSafeInteger(Number(match[1])))
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
        return (await read("get_starred"))?.starred === params.starred;
      },
    },
  );
  return {
    receipt,
    data:
      receipt.state === "verified"
        ? {
            ...target,
            starred: params.starred,
            changed: receipt.reference?.id.endsWith("/changed") === true,
            verified: true,
          }
        : { ...target, desiredStarred: params.starred, verified: false },
  };
}
