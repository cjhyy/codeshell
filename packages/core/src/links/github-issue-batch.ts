import { resolveActiveWorkspaceProfileSelection } from "../profile/resolve.js";
import { createHash } from "node:crypto";
import { SettingsManager } from "../settings/manager.js";
import { resolveRunProfileState } from "../engine/run-setup.js";
import { effectiveBuiltinLists, effectiveProjectOverrides } from "../capability-control/overlay.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { prepareConfiguredToolHooks } from "../hooks/configured-tool-hooks.js";
import {
  canonicalOperationValue,
  OperationLedger,
  type OperationPlan,
} from "../operations/ledger.js";
import { readOperationSessionOwner } from "../operations/session-owner.js";
import type { CredentialMetadata } from "../credentials/access.js";
import { githubCreateIssueParameters } from "./github-create-issue.js";
import { githubOperationPlan } from "./operation-recovery.js";
import { linkAuthoritySnapshot } from "./authority.js";

export const GITHUB_ISSUE_BATCH_MAX_ITEMS = 8;
const MAX_MANIFEST_BYTES = 160 * 1024;
export function normalizeGithubIssueBatch(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > GITHUB_ISSUE_BATCH_MAX_ITEMS)
    throw new Error("Issue batch requires 1–8 explicit items");
  const seen = new Set<string>();
  const items = input.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !["owner", "repo", "title", "body"].includes(key))
    )
      throw new Error("Invalid Issue batch item");
    const value = githubCreateIssueParameters(item as Record<string, unknown>);
    const identity = canonicalOperationValue(value, 160 * 1024);
    if (seen.has(identity)) throw new Error("Duplicate Issue batch items are not implicit slots");
    seen.add(identity);
    return value;
  });
  canonicalOperationValue(items, MAX_MANIFEST_BYTES);
  return items;
}

/** Native-only issuer. No tool-call/renderer ID or array can create this object. */
export function createGithubIssueBatch(input: {
  root: string;
  sessionId: string;
  originIntent: string;
  connection: CredentialMetadata;
  items: unknown;
  assertCurrent(): void;
}) {
  const items = normalizeGithubIssueBatch(input.items);
  const connection = structuredClone(input.connection);
  const ledger = new OperationLedger(input.root, undefined, {
    sessionId: input.sessionId,
    read: () => readOperationSessionOwner(input.root, input.sessionId),
  });
  const plans = items.map((params) =>
    githubOperationPlan(input.sessionId, input.originIntent, connection, "create_issue", params),
  );
  const anchor: OperationPlan = {
    ...plans[0],
    target: { kind: "host.issue_batch.v1" },
    parameters: { kind: "host.issue_batch.v1", items },
    postcondition: { kind: "host.issue_batch.v1", authority: linkAuthoritySnapshot(connection) },
  };
  const reservation = ledger.reserveBatch(
    anchor,
    plans,
    { kind: "host.issue_batch.v1", approvedBy: "native-default-cancel" },
    input.assertCurrent,
  );
  let closed = false;
  const receipts = () => ledger.batchReceipts(anchor, plans);
  return {
    id: reservation.anchor.id,
    count: items.length,
    /** Exact normalized parameters select their fixed slot; call count never does. */
    resolve(parameters: Record<string, unknown>) {
      if (closed) throw new Error("Issue batch permit has ended");
      input.assertCurrent();
      const identity = canonicalOperationValue(
        githubCreateIssueParameters(parameters),
        MAX_MANIFEST_BYTES,
      );
      const index = items.findIndex(
        (item) => canonicalOperationValue(item, MAX_MANIFEST_BYTES) === identity,
      );
      if (index < 0) throw new Error("Issue parameters are outside the approved batch");
      const current = receipts();
      if (current.slice(0, index).some((receipt) => receipt.state !== "verified"))
        throw new Error("Previous Issue batch slot must be verified first");
      if (
        current.some(
          (receipt) => ["unknown", "blocked"].includes(receipt.state) || Boolean(receipt.error),
        )
      )
        throw new Error("Issue batch is sealed or incomplete");
      return {
        kind: "batch" as const,
        batchId: reservation.anchor.id,
        index,
        count: items.length,
        ...(index > 0 ? { previousVerifiedId: current[index - 1].id } : {}),
      };
    },
    finish() {
      if (closed) throw new Error("Issue batch permit has ended");
      input.assertCurrent();
      const allVerified = receipts().every((receipt) => receipt.state === "verified");
      closed = true;
      ledger.sealBatch(anchor, plans);
      return {
        kind: "batch" as const,
        batchId: reservation.anchor.id,
        index: 0,
        count: items.length,
        allVerified,
      };
    },
    close() {
      closed = true;
      ledger.sealBatch(anchor, plans);
    },
  };
}

/** Same effective Profile/default selection as Engine, read without migration writes.
 * Any policy drift revokes this batch; this digest never grants tool permission.
 */
export function githubIssueBatchPolicy(cwd: string, sessionProfile?: string): string {
  const settings = new SettingsManager(cwd, "full", true);
  settings.load(undefined, { persistMigrations: false, hookOrigins: true });
  const selection = resolveActiveWorkspaceProfileSelection({ sessionProfile, cwd, settings });
  if (selection.name && !selection.profile) throw new Error("Batch Profile is unavailable");
  const profile = resolveRunProfileState({
    sessionWorkspaceProfile: sessionProfile,
    cwd,
    settings,
  });
  const lists = computeEffectiveDisabledLists(settings, cwd, profile.sessionProfileOverrides);
  const builtin = effectiveBuiltinLists(
    settings.get().agent.enabledBuiltinTools ?? [],
    settings.get().agent.disabledBuiltinTools ?? [],
    effectiveProjectOverrides(settings, cwd, profile.sessionProfileOverrides)?.builtin,
  );
  const hooks = prepareConfiguredToolHooks({
    settings,
    cwd,
    settingsScope: "full",
    disabledPlugins: lists.disabledPlugins,
    disabledPluginHooks: lists.disabledPluginHooks,
    toolName: "LinkAction",
  });
  return createHash("sha256")
    .update(
      canonicalOperationValue(
        {
          scope: "full",
          profileName: selection.name ?? null,
          profile: profile.workspaceProfile ?? null,
          permissions: settings.get().permissions ?? null,
          builtin,
          configuredHooks: hooks.revision,
        },
        512 * 1024,
      ),
    )
    .digest("hex");
}
