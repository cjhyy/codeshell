import type { LinkConnectionRecipe, LinkRecipeId } from "./operation-types.js";

export const LINK_CONNECTION_RECIPES: Readonly<Record<LinkRecipeId, LinkConnectionRecipe>> =
  Object.freeze({
    "api-token": Object.freeze({
      id: "api-token",
      auth: "static-secret",
      executor: "api",
      route: "direct",
      credentialOwner: "current-host",
      executorOwner: "current-host",
    }),
    "api-oauth": Object.freeze({
      id: "api-oauth",
      auth: "oauth2",
      executor: "api",
      route: "direct",
      credentialOwner: "current-host",
      executorOwner: "current-host",
    }),
    "cli-session": Object.freeze({
      id: "cli-session",
      auth: "external-session",
      executor: "cli",
      route: "direct",
      credentialOwner: "external-session-owner",
      executorOwner: "current-host",
    }),
    "broker-oauth": Object.freeze({
      id: "broker-oauth",
      auth: "oauth2",
      executor: "api",
      route: "brokered",
      credentialOwner: "broker",
      executorOwner: "broker",
    }),
    "mcp-oauth": Object.freeze({
      id: "mcp-oauth",
      auth: "oauth2",
      executor: "mcp",
      route: "direct",
      credentialOwner: "current-host",
      executorOwner: "current-host",
    }),
  });

export function getLinkConnectionRecipe(id: string): LinkConnectionRecipe | undefined {
  return Object.hasOwn(LINK_CONNECTION_RECIPES, id)
    ? LINK_CONNECTION_RECIPES[id as LinkRecipeId]
    : undefined;
}

/** Compatibility at the host boundary; new records identify a reviewed recipe. */
export function resolveLinkRecipeId(metadata: {
  linkRecipeId?: string;
  linkExecutionBackend?: string;
  linkAuthSource?: string;
}): LinkRecipeId | undefined {
  if (metadata.linkRecipeId) return getLinkConnectionRecipe(metadata.linkRecipeId)?.id;
  if (metadata.linkExecutionBackend === "remote") return "broker-oauth";
  if (metadata.linkExecutionBackend === "mcp") return "mcp-oauth";
  if (metadata.linkExecutionBackend === "cli") return "cli-session";
  if (metadata.linkAuthSource === "browser-oauth") return "api-oauth";
  if (metadata.linkExecutionBackend === "http-token") return "api-token";
  return undefined;
}
