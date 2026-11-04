import type { LinkProviderView } from "@cjhyy/code-shell-link";
import type { AccountFeatureView } from "../src/account/features.js";

/** Cloud gating affects remote methods only. Saved grants retain their cleanup controls. */
export function accountLinkMethods(
  provider: LinkProviderView,
  feature: AccountFeatureView | null,
): LinkProviderView {
  if (!feature || feature.state === "ready") return provider;
  const remote = new Set(
    provider.connectionMethods
      .filter((method) => method.executionRuntime === "server")
      .map((method) => method.id),
  );
  return {
    ...provider,
    connectionMethods: provider.connectionMethods.filter(
      (method) => feature.state !== "hidden" || !remote.has(method.id),
    ),
    ...(provider.authModes
      ? {
          authModes: provider.authModes
            .filter((mode) => feature.state !== "hidden" || !remote.has(mode.methodId))
            .map((mode) =>
              remote.has(mode.methodId)
                ? {
                    ...mode,
                    available: false,
                    unavailableReason:
                      feature.state === "sign-in" ? "登录后可用" : "账号服务暂时无法连接，请重试。",
                  }
                : mode,
            ),
        }
      : {}),
  };
}
