import { githubRepositoryParameters } from "./github-star.js";
import { asRecord } from "./http.js";

export const githubIssueStateActionIds = ["get_repository", "get_issue", "update_issue"] as const;

/** This adapter deliberately cannot update title, body, labels or state_reason. */
export function githubIssueStateParameters(input: Record<string, unknown>): {
  owner: string;
  repo: string;
  issue_number: number;
  state: "open" | "closed";
} {
  const { issue_number, state, ...target } = input;
  if (!Number.isSafeInteger(issue_number) || (issue_number as number) <= 0)
    throw new Error("GitHub issue_number must be a positive safe integer");
  if (state !== "open" && state !== "closed") throw new Error("Invalid GitHub issue state");
  return { ...githubRepositoryParameters(target), issue_number: issue_number as number, state };
}

/** A path is not identity: reject PRs, redirects and repository/number mismatches. */
export function githubIssueIdentity(
  value: unknown,
  target: { owner: string; repo: string; issue_number: number },
): { id: number; state: "open" | "closed" } | undefined {
  const issue = asRecord(value);
  const repositoryUrl = `https://api.github.com/repos/${target.owner}/${target.repo}`;
  if (
    !Number.isSafeInteger(issue?.id) ||
    (issue!.id as number) <= 0 ||
    issue?.number !== target.issue_number ||
    (issue.state !== "open" && issue.state !== "closed") ||
    Object.hasOwn(issue, "pull_request") ||
    typeof issue.repository_url !== "string" ||
    issue.repository_url.toLowerCase() !== repositoryUrl ||
    typeof issue.url !== "string" ||
    issue.url.toLowerCase() !== `${repositoryUrl}/issues/${target.issue_number}`
  )
    return undefined;
  return { id: issue.id as number, state: issue.state };
}
