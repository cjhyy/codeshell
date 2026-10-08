import { pathSegmentParam } from "./http.js";

export const githubStarActionIds = ["get_repository", "get_starred", "set_starred"] as const;

/** One target and one desired boolean; never arbitrary API methods or payloads. */
export function githubRepositoryParameters(input: Record<string, unknown>): {
  owner: string;
  repo: string;
} {
  if (Object.keys(input).some((key) => !["owner", "repo"].includes(key)))
    throw new Error("Unknown GitHub repository parameter");
  const owner = pathSegmentParam(input, "owner", { required: true, maxLength: 39 })!.toLowerCase();
  const repo = pathSegmentParam(input, "repo", { required: true, maxLength: 100 })!.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner) || !/^[a-z0-9_.-]{1,100}$/.test(repo))
    throw new Error("Invalid GitHub repository");
  return { owner, repo };
}

export function githubSetStarredParameters(input: Record<string, unknown>): {
  owner: string;
  repo: string;
  starred: boolean;
} {
  const { starred, ...target } = input;
  if (typeof starred !== "boolean") throw new Error("GitHub starred must be a boolean");
  return { ...githubRepositoryParameters(target), starred };
}
