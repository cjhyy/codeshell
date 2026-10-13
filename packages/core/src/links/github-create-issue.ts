import { pathSegmentParam, stringParam } from "./http.js";

/** Fixed GitHub semantics live beside the provider, not in the generic controller. */
export function githubCreateIssueParameters(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const owner = pathSegmentParam(input, "owner", { required: true, maxLength: 100 })!;
  const repo = pathSegmentParam(input, "repo", { required: true, maxLength: 100 })!;
  const title = stringParam(input, "title", { required: true, maxLength: 256 })!;
  const body = stringParam(input, "body", { maxLength: 20_000 });
  return { owner, repo, title, ...(body ? { body } : {}) };
}
