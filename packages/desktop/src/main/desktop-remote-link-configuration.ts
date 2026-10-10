import { remoteLinkFromEnvironment } from "@cjhyy/code-shell-server/links";

/** Public deployment metadata only. Provider credentials remain in the Link service. */
export const packagedRemoteLinkEnvironment: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  CODE_SHELL_REMOTE_LINK_ISSUER: "https://115.159.45.55:8443",
  CODE_SHELL_REMOTE_LINK_CLIENT_ID: "3c81a13d-8c0b-4e9e-b0ab-13b80e3cf3f9",
  CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN: "http://127.0.0.1:43827",
});

/** A custom deployment is complete on its own; never mix it with public defaults. */
export function desktopRemoteLinkEnvironment(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
): NodeJS.ProcessEnv | undefined {
  if (environment.CODE_SHELL_REMOTE_LINK_DISABLED === "1") return undefined;
  const custom = [
    "CODE_SHELL_REMOTE_LINK_ISSUER",
    "CODE_SHELL_REMOTE_LINK_CLIENT_ID",
    "CODE_SHELL_REMOTE_LINK_CLIENT_SECRET",
    "CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN",
  ].some((key) => environment[key] !== undefined);
  return custom || !isPackaged ? environment : packagedRemoteLinkEnvironment;
}

/** Resolve the selected deployment through the Host's existing origin validation. */
export function desktopRemoteLinkConfiguration(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
) {
  const selected = desktopRemoteLinkEnvironment(environment, isPackaged);
  return selected?.CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN
    ? remoteLinkFromEnvironment(selected, selected.CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN)
    : undefined;
}
