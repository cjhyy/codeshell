/** Desktop retains browser/clipboard behavior; the device flow is host-neutral. */
export { LinkDeviceOAuthBroker, isLocalBrowserLinkProvider } from "@cjhyy/code-shell-server/links";
export type {
  LocalBrowserAuthStatus,
  LocalBrowserAuthPrompt,
  LocalBrowserAuthToken,
  LocalBrowserLinkProviderId,
} from "@cjhyy/code-shell-server/links";

/** A rejected clipboard write still leaves the user able to complete device authorization. */
export async function copyOrShowDeviceCode(
  code: string,
  copy: (code: string) => Promise<void>,
  show: (code: string) => Promise<void>,
): Promise<boolean> {
  try {
    await copy(code);
    return true;
  } catch {
    await show(code);
    return false;
  }
}
