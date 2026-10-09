import type {
  OperationPlan,
  OperationReceipt,
  OperationObservation,
} from "../operations/ledger.js";
import type { GithubReconcileRead } from "./operation-reader.js";
import { asRecord } from "./http.js";
import { githubIssueIdentity, githubIssueStateParameters } from "./github-issue-state.js";
import { githubSetStarredParameters } from "./github-star.js";
import { githubCreateIssueParameters } from "./verified-write.js";

const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** Exact closed read set. Matching present state never establishes original-attempt causality. */
export async function observeGithubOperation(options: {
  plan: OperationPlan;
  receipt: OperationReceipt;
  identity?: Record<string, unknown> | null;
  read(
    action: GithubReconcileRead,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  assertAuthorized(): void;
}): Promise<{ result: OperationObservation["result"]; actions: string[]; evidence: unknown }> {
  const { plan, receipt } = options;
  const actions: string[] = [];
  const read = async (action: GithubReconcileRead, params: Record<string, unknown>) => {
    options.assertAuthorized();
    actions.push(`github.${action}`);
    const value = await options.read(action, params);
    options.assertAuthorized();
    return value;
  };
  const unavailable = () => ({
    result: "unavailable" as const,
    actions,
    evidence: { reason: "immutable_identity_missing" },
  });
  if (plan.service !== "github" || !asRecord(plan.parameters)) return unavailable();
  if (plan.action === "set_starred") {
    const params = githubSetStarredParameters(plan.parameters as Record<string, unknown>);
    const target = { owner: params.owner, repo: params.repo };
    const reference = receipt.reference?.id.match(
      /^([1-9][0-9]*)\/(starred|unstarred)\/(changed|unchanged)$/,
    );
    const repositoryId = reference ? Number(reference[1]) : options.identity?.repositoryId;
    if (!positive(repositoryId) || (reference && (reference[2] === "starred") !== params.starred))
      return unavailable();
    const repository = await read("get_repository", target);
    if (
      repository?.id !== repositoryId ||
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== `${params.owner}/${params.repo}`
    )
      return { result: "identity_changed", actions, evidence: { repositoryId, matches: false } };
    const observed = await read("get_starred", target);
    if (typeof observed?.starred !== "boolean")
      return { result: "unavailable", actions, evidence: { reason: "invalid_read" } };
    return {
      result: observed.starred === params.starred ? "matches_current" : "differs_current",
      actions,
      evidence: { repositoryId, starred: observed.starred },
    };
  }
  if (plan.action === "update_issue") {
    const params = githubIssueStateParameters(plan.parameters as Record<string, unknown>);
    const repositoryTarget = { owner: params.owner, repo: params.repo };
    const target = { ...repositoryTarget, issue_number: params.issue_number };
    const reference = receipt.reference?.id.match(
      /^([1-9][0-9]*)\/([1-9][0-9]*)\/([1-9][0-9]*)\/(open|closed)\/(changed|unchanged)$/,
    );
    const repositoryId = reference ? Number(reference[1]) : options.identity?.repositoryId;
    const issueId = reference ? Number(reference[2]) : options.identity?.issueId;
    if (
      !positive(repositoryId) ||
      !positive(issueId) ||
      (reference && (Number(reference[3]) !== params.issue_number || reference[4] !== params.state))
    )
      return unavailable();
    const repository = await read("get_repository", repositoryTarget);
    if (
      repository?.id !== repositoryId ||
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== `${params.owner}/${params.repo}`
    )
      return { result: "identity_changed", actions, evidence: { repositoryId, matches: false } };
    const issue = githubIssueIdentity(await read("get_issue", target), target);
    if (!issue || issue.id !== issueId)
      return {
        result: "identity_changed",
        actions,
        evidence: { repositoryId, issueId, matches: false },
      };
    return {
      result: issue.state === params.state ? "matches_current" : "differs_current",
      actions,
      evidence: { repositoryId, issueId, state: issue.state },
    };
  }
  if (plan.action === "create_issue") {
    const params = githubCreateIssueParameters(plan.parameters as Record<string, unknown>);
    const number =
      receipt.reference?.id && /^[1-9][0-9]*$/.test(receipt.reference.id)
        ? Number(receipt.reference.id)
        : options.identity?.issueNumber;
    const issueId = options.identity?.issueId;
    // A later GET at the same number/title is not an immutable original identity.
    if (!positive(number) || !positive(issueId) || options.identity?.issueNumber !== number)
      return unavailable();
    const target = {
      owner: params.owner as string,
      repo: params.repo as string,
      issue_number: number,
    };
    const observed = await read("get_issue", target);
    const issue = githubIssueIdentity(observed, target);
    if (!issue || issue.id !== issueId)
      return { result: "identity_changed", actions, evidence: { issueId, matches: false } };
    const matches =
      observed?.title === params.title &&
      (observed?.body ?? "") === (params.body ?? "") &&
      issue.state === "open";
    return {
      result: matches ? "matches_current" : "differs_current",
      actions,
      evidence: {
        issueId,
        number,
        titleMatches: observed?.title === params.title,
        bodyMatches: (observed?.body ?? "") === (params.body ?? ""),
        state: issue.state,
      },
    };
  }
  return unavailable();
}
