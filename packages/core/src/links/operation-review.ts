import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OperationReviewStore } from "../operations/review-store.js";
import type { OperationSessionOwner } from "../operations/session-owner.js";
import type { OperationReceipt } from "../operations/ledger.js";
import { getCredentialAccess, credentialAccessScope } from "../credentials/access.js";
import type { SettingsScope } from "../settings/manager.js";
import { asRecord } from "./http.js";
import { canonicalOperationValue } from "../operations/ledger.js";
import { githubOperationPlan } from "./operation-recovery.js";
import { githubSetStarredParameters } from "./github-star.js";
import { githubIssueStateParameters } from "./github-issue-state.js";
import { githubCreateIssueParameters } from "./verified-write.js";
import { allowsLinkAction, linkAuthoritySnapshot } from "./authority.js";
import {
  createGithubOperationReader,
  OperationReadFailure,
  type GithubReconcileRead,
} from "./operation-reader.js";
import { observeGithubOperation } from "./operation-reconcile.js";
import { readOperationSessionOwner } from "../operations/session-owner.js";

/** Host-only Link adapter for existing activity review; provider semantics stay outside generic operations. */
export function createLinkOperationReviewStore(root: string) {
  const store = new OperationReviewStore(root, legacyLinkOperationEvidence);
  return {
    review: store.review.bind(store),
    resolve: store.resolve.bind(store),
    async reconcile(
      sessionId: string,
      owner: OperationSessionOwner,
      id: string,
      revision: string,
      options: {
        cwd: string;
        /** Configured Desktop Host authority; never supplied by the renderer. */
        settingsScope: SettingsScope;
        assertCurrent(): void;
        approveRead(action: GithubReconcileRead, target: string): Promise<boolean>;
      },
    ) {
      const assertOwner = () => {
        options.assertCurrent();
        const current = readOperationSessionOwner(root, sessionId);
        if (current.binding !== owner.binding || current.state.status === "active")
          throw new Error("Operation Session changed or is running");
      };
      const original = store.readRecovery(sessionId, owner, id, revision, assertOwner);
      const payload = asRecord(original.input?.payload);
      const policy = asRecord(payload?.policy);
      const originalScope = (policy?.settingsScope ?? "project") as SettingsScope;
      if (
        !["full", "project", "isolated"].includes(originalScope) ||
        !["full", "project", "isolated"].includes(options.settingsScope)
      )
        throw new Error("Original read scope is unproven");
      // Missing legacy scope never confers access to user/global connections.
      // Policy is always evaluated under current trusted Host settings below;
      // only credential custody is narrowed to the proven intersection.
      const scope =
        originalScope === "isolated" || options.settingsScope === "isolated"
          ? "isolated"
          : originalScope === "project" || options.settingsScope === "project"
            ? "project"
            : "full";
      const access = getCredentialAccess();
      const resolveConnection = (connectionId: unknown) =>
        typeof connectionId === "string"
          ? access.resolveMeta(options.cwd, connectionId, credentialAccessScope(scope))
          : undefined;
      let plan = original.input?.plan;
      let connection = resolveConnection(asRecord(plan?.account)?.connectionId);
      if (!plan) {
        for (const candidate of legacyLinkOperationCandidates(owner, original.receipt)) {
          const selected = resolveConnection(candidate.connectionId);
          if (!selected) continue;
          try {
            const params =
              candidate.action === "set_starred"
                ? githubSetStarredParameters(candidate.params)
                : candidate.action === "update_issue"
                  ? githubIssueStateParameters(candidate.params)
                  : githubCreateIssueParameters(candidate.params);
            const proposed = githubOperationPlan(
              sessionId,
              candidate.originIntent,
              selected,
              candidate.action,
              params,
            );
            if (store.provePlan(sessionId, original.receipt, proposed)) {
              plan = proposed;
              connection = selected;
              break;
            }
          } catch {
            /* Unproven or changed original input remains unavailable. */
          }
        }
      }
      const masked = (observation: ReturnType<OperationReviewStore["observe"]>) => ({
        id: observation.id,
        at: observation.at,
        result: observation.result,
        actions: observation.actions,
      });
      const unavailable = () =>
        masked(
          store.observe(
            sessionId,
            owner,
            id,
            revision,
            "unavailable",
            [],
            { reason: "original_plan_or_authority_unproven" },
            assertOwner,
          ),
        );
      if (
        !plan ||
        !connection?.hasSecret ||
        connection.meta?.linkProvider !== "github" ||
        connection.meta.linkExecutionBackend === "cli" ||
        !store.provePlan(sessionId, original.receipt, plan)
      )
        return unavailable();
      const authority = linkAuthoritySnapshot(connection);
      if (
        (payload && payload.authority !== authority) ||
        (policy &&
          (policy.planMode !== false ||
            policy.linkActionEnabled !== true ||
            policy.linkActionAllowed !== true ||
            ["dontAsk", "bypassPermissions"].includes(String(policy.permissionMode))))
      )
        return unavailable();
      const invalidated = new AbortController();
      const assertCurrent = () => {
        assertOwner();
        const live = resolveConnection(connection!.id);
        if (
          !live?.hasSecret ||
          linkAuthoritySnapshot(live) !== authority ||
          !allowsLinkAction(live, "github", plan!.action)
        ) {
          invalidated.abort();
          throw new Error("Original Link account or grant changed");
        }
      };
      const unsubscribe = access.subscribe?.(
        () => {
          try {
            assertCurrent();
          } catch {
            invalidated.abort();
          }
        },
        { cwd: options.cwd, scope: credentialAccessScope(scope) },
      );
      try {
        assertCurrent();
        let reader: ReturnType<typeof createGithubOperationReader>;
        try {
          reader = createGithubOperationReader({
            cwd: options.cwd,
            sessionId,
            settingsScope: options.settingsScope,
            credentialScope: scope,
            ...(typeof owner.state.workspaceProfile === "string"
              ? { sessionProfile: owner.state.workspaceProfile }
              : {}),
            assertAuthorized: assertCurrent,
            approveRead: options.approveRead,
            signal: AbortSignal.any([invalidated.signal, AbortSignal.timeout(30_000)]),
          });
        } catch (error) {
          if (!(error instanceof OperationReadFailure) || error.result !== "hooks_unavailable")
            throw error;
          return masked(
            store.observe(
              sessionId,
              owner,
              id,
              revision,
              "hooks_unavailable",
              [],
              { reason: "configured_tool_hooks_not_executed" },
              assertCurrent,
            ),
          );
        }
        if (policy && policy.workspaceProfileName !== reader.profileName) return unavailable();
        const attempted: string[] = [];
        let result: Awaited<ReturnType<typeof observeGithubOperation>>;
        try {
          result = await observeGithubOperation({
            plan,
            receipt: original.receipt,
            identity: asRecord(payload?.identity),
            assertAuthorized: assertCurrent,
            read: (action, params) => {
              assertCurrent();
              attempted.push(`github.${action}`);
              if (!allowsLinkAction(connection!, "github", action))
                throw new OperationReadFailure("permission_denied");
              return reader.read(action, connection!.id, params);
            },
          });
        } catch (error) {
          reader.assertAuthorized();
          result = {
            result: error instanceof OperationReadFailure ? error.result : "unavailable",
            actions: attempted,
            evidence: { reason: "fixed_read_unavailable" },
          };
        }
        reader.assertAuthorized();
        const observation = store.observe(
          sessionId,
          owner,
          id,
          revision,
          result.result,
          result.actions,
          JSON.parse(canonicalOperationValue(result.evidence)),
          reader.assertAuthorized,
        );
        return {
          id: observation.id,
          at: observation.at,
          result: observation.result,
          actions: observation.actions,
        };
      } finally {
        unsubscribe?.();
        invalidated.abort();
      }
    },
  };
}

/** Original trusted user turn and paired typed Link call, never assistant prose. */
export function legacyLinkOperationCandidates(
  owner: OperationSessionOwner,
  receipt: OperationReceipt,
): Array<{
  originIntent: string;
  connectionId?: string;
  action: "create_issue" | "set_starred" | "update_issue";
  params: Record<string, unknown>;
}> {
  const result: ReturnType<typeof legacyLinkOperationCandidates> = [];
  let fd: number | undefined;
  try {
    fd = openSync(
      join(owner.directory, "transcript.jsonl"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > 8 * 1024 * 1024) return result;
    const events = readFileSync(fd, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (events.length > 20_000) return result;
    const meta = events.find((event) => event.type === "session_meta");
    if (meta?.data?.startedAt !== owner.startedAt || meta.data.sessionId !== owner.state.sessionId)
      return result;
    let originIntent: string | undefined;
    const calls = new Map<string, { originIntent: string; args: Record<string, unknown> }>();
    const duplicates = new Set<string>();
    for (const event of events) {
      const data = event.data;
      if (event.type === "message" && data?.role === "user") {
        originIntent =
          typeof data.clientMessageId === "string" && data.clientMessageId.length <= 400
            ? data.clientMessageId
            : undefined;
      }
      if (event.type === "run_result") originIntent = undefined;
      if (event.type === "tool_use" && data?.toolName === "LinkAction" && originIntent) {
        if (calls.has(data.toolCallId)) duplicates.add(data.toolCallId);
        calls.set(data.toolCallId, { originIntent, args: data.args });
      }
      if (
        event.type !== "tool_result" ||
        data?.toolName !== "LinkAction" ||
        typeof data.result !== "string" ||
        duplicates.has(data.toolCallId)
      )
        continue;
      let output;
      try {
        output = JSON.parse(data.result);
      } catch {
        continue;
      }
      const call = calls.get(data.toolCallId);
      const operation = output?.operation;
      if (
        !call ||
        output.kind !== "unverified_write" ||
        output.untrustedExternalContent !== true ||
        output.provider !== "github" ||
        call.args?.provider !== "github" ||
        !["create_issue", "set_starred", "update_issue"].includes(output.action) ||
        call.args.action !== output.action ||
        operation?.id !== receipt.id ||
        operation.owner !== receipt.owner ||
        operation.fingerprint !== receipt.fingerprint ||
        operation.attemptId !== receipt.attemptId ||
        !call.args.params ||
        typeof call.args.params !== "object" ||
        Array.isArray(call.args.params) ||
        (call.args.connectionId !== undefined && call.args.connectionId !== output.connectionId)
      )
        continue;
      result.push({
        originIntent: call.originIntent,
        connectionId: output.connectionId,
        action: output.action,
        params: call.args.params as Record<string, unknown>,
      });
      if (result.length >= 8) break;
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return result;
}

/** Legacy ownership needs actual matching receipts in this incarnation's bounded transcript. */
export function legacyLinkOperationEvidence(owner: OperationSessionOwner): Map<string, string> {
  const result = new Map<string, string>();
  let fd: number | undefined;
  try {
    fd = openSync(
      join(owner.directory, "transcript.jsonl"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > 8 * 1024 * 1024) return result;
    const events = readFileSync(fd, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const meta = events.find((event) => event.type === "session_meta");
    if (meta?.data?.startedAt !== owner.startedAt || meta.data.sessionId !== owner.state.sessionId)
      return result;
    const calls = new Map(
      events
        .filter((event) => event.type === "tool_use" && event.data?.toolName === "LinkAction")
        .map((event) => [event.data.toolCallId, event.data.args]),
    );
    for (const event of events) {
      if (
        event.type !== "tool_result" ||
        event.data?.toolName !== "LinkAction" ||
        typeof event.data?.result !== "string"
      )
        continue;
      let output;
      try {
        output = JSON.parse(event.data.result);
      } catch {
        continue;
      }
      const receipt = output?.operation;
      const call = calls.get(event.data.toolCallId);
      if (
        call?.provider !== "github" ||
        call.action !== output.action ||
        output.kind !== "unverified_write" ||
        output.untrustedExternalContent !== true ||
        output.provider !== "github" ||
        !receipt ||
        !receipt.attemptId ||
        !["create_issue", "set_starred", "update_issue"].includes(output.action)
      )
        continue;
      result.set(
        receipt.id,
        JSON.stringify([receipt.owner, receipt.fingerprint, receipt.attemptId]),
      );
    }
  } catch {
    return new Map();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return result;
}
