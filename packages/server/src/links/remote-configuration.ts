import { beginRemoteLinkAuthorization, type RemoteLinkConfiguration } from "@cjhyy/code-shell-core";

/** Validate trusted deployment input without echoing credentials in startup errors. */
export function remoteLinkHostConfiguration(
  input: RemoteLinkConfiguration | undefined,
  publicOrigin: string | undefined,
  callbackPath: "/link/callback" | "/mobile/link/callback" = "/link/callback",
): RemoteLinkConfiguration | undefined {
  if (input === undefined) return undefined;
  try {
    if (!["/link/callback", "/mobile/link/callback"].includes(callbackPath))
      throw new Error("path");
    if (!publicOrigin || new URL(publicOrigin).origin !== publicOrigin) throw new Error("origin");
    const config = beginRemoteLinkAuthorization(input).configuration;
    if (config.redirectUri !== `${publicOrigin}${callbackPath}`) throw new Error("callback");
    return Object.freeze(config);
  } catch {
    throw new Error(
      "Remote Link requires a valid service, client ID and the exact public Link callback URL.",
    );
  }
}

export function remoteLinkFromEnvironment(
  env: NodeJS.ProcessEnv,
  publicOrigin: string | undefined,
  callbackPath: "/link/callback" | "/mobile/link/callback" = "/link/callback",
): RemoteLinkConfiguration | undefined {
  const issuer = env.CODE_SHELL_REMOTE_LINK_ISSUER;
  const clientId = env.CODE_SHELL_REMOTE_LINK_CLIENT_ID;
  const clientSecret = env.CODE_SHELL_REMOTE_LINK_CLIENT_SECRET;
  if (!issuer && !clientId && !clientSecret) return undefined;
  return remoteLinkHostConfiguration(
    {
      issuer: issuer ?? "",
      clientId: clientId ?? "",
      redirectUri: `${publicOrigin}${callbackPath}`,
      ...(clientSecret ? { clientSecret } : {}),
    },
    publicOrigin,
    callbackPath,
  );
}
