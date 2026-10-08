import type {
  NativeLinkAuthorizationInput,
  NativeLinkAuthorizationWindow,
} from "./remote-link-manager.js";
import type { createLinkLoopbackCallbackBroker } from "./link-loopback-callback.js";

/** Injectable for real HTTP callback verification without opening a user's browser session. */
export function createSystemBrowserLinkAuthorization(options: {
  callbacks: ReturnType<typeof createLinkLoopbackCallbackBroker>;
  openExternal(url: string): Promise<unknown>;
}) {
  return async (input: NativeLinkAuthorizationInput): Promise<NativeLinkAuthorizationWindow> => {
    const url = new URL(input.authorizationUrl);
    const state = url.searchParams.get("state");
    if (
      !state ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("redirect_uri") !== input.redirectUri ||
      url.searchParams.getAll("redirect_uri").length !== 1 ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Link 授权地址无效。");
    const callback = await options.callbacks.register({
      redirectUri: input.redirectUri,
      state,
      expiresAt: Date.parse(input.expiresAt ?? ""),
      signal: input.signal,
      onCallback: input.onCallback,
      onCancel: input.onCancel,
    });
    let closed = false;
    let launching: Promise<unknown> | undefined;
    const close = () => {
      closed = true;
      callback.close();
    };
    const launch = async () => {
      if (closed || input.signal?.aborted || Date.parse(input.expiresAt ?? "") <= Date.now())
        return;
      if (launching) {
        await launching;
        return;
      }
      launching = options.openExternal(url.href);
      try {
        await launching;
      } finally {
        launching = undefined;
      }
    };
    try {
      await launch();
      if (input.signal?.aborted) close();
      return { close, focus: launch };
    } catch (error) {
      close();
      throw error;
    }
  };
}
