import { beginRemoteLinkAuthorization, type RemoteLinkConfiguration } from "@cjhyy/code-shell-core";

/** Validate trusted deployment input without echoing credentials in startup errors. */
export function remoteLinkHostConfiguration(
  input: RemoteLinkConfiguration | undefined,
  publicOrigin: string | undefined,
): RemoteLinkConfiguration | undefined {
  if (input === undefined) return undefined;
  try {
    if (!publicOrigin || new URL(publicOrigin).origin !== publicOrigin) throw new Error("origin");
    const config = beginRemoteLinkAuthorization(input).configuration;
    if (config.redirectUri !== `${publicOrigin}/link/callback`) throw new Error("callback");
    return Object.freeze(config);
  } catch {
    throw new Error(
      "Remote Link requires a valid service, client ID and the public /link/callback URL.",
    );
  }
}

export function remoteLinkFromEnvironment(
  env: NodeJS.ProcessEnv,
  publicOrigin: string | undefined,
): RemoteLinkConfiguration | undefined {
  const issuer = env.CODE_SHELL_REMOTE_LINK_ISSUER;
  const clientId = env.CODE_SHELL_REMOTE_LINK_CLIENT_ID;
  const clientSecret = env.CODE_SHELL_REMOTE_LINK_CLIENT_SECRET;
  if (!issuer && !clientId && !clientSecret) return undefined;
  return remoteLinkHostConfiguration(
    {
      issuer: issuer ?? "",
      clientId: clientId ?? "",
      redirectUri: `${publicOrigin}/link/callback`,
      ...(clientSecret ? { clientSecret } : {}),
    },
    publicOrigin,
  );
}
