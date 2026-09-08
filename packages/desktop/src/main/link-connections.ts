import {
  connectCliLink,
  validateLocalLinkToken,
  type CliLinkProviderId,
  type CredentialStore,
} from "@cjhyy/code-shell-core";
import {
  createLinkService,
  type LinkConnectionInput,
  type LocalBrowserAuthToken,
} from "@cjhyy/code-shell-server/links";

interface ConnectionInput {
  providerId: string;
  methodId: string;
  label: string;
  existingId: string;
}
interface Options {
  cwd?: string;
  store?: CredentialStore;
  onChanged?: () => void;
  validateToken?: typeof validateLocalLinkToken;
  connectCli?: typeof connectCliLink;
}

/** Desktop owns interactive login; the shared service owns the credential transaction. */
export function createDesktopLinkConnections(options: Options) {
  const service = createLinkService(options);
  const context = { ownerId: "desktop-main", authorize: () => true };
  function reviewed(input: ConnectionInput): LinkConnectionInput {
    const prior = input.existingId
      ? service.snapshot().connections.find((connection) => connection.id === input.existingId)
      : undefined;
    if (
      input.existingId &&
      (!prior || prior.providerId !== input.providerId || prior.methodId !== input.methodId)
    )
      throw new Error("The existing credential does not belong to this local Link provider");
    return {
      providerId: input.providerId,
      methodId: input.methodId,
      label: input.label || `${input.providerId} · ${input.methodId}`,
      ...(input.existingId ? { connectionId: input.existingId } : {}),
      expectedRevision: prior?.revision ?? null,
    };
  }
  return {
    close: service.close,
    async connectLocal(
      input: ConnectionInput & {
        token: string;
        browserOAuthToken?: LocalBrowserAuthToken;
        authSource: "manual-token" | "browser-oauth";
      },
    ) {
      // Capture the CAS revision before touching the provider, never afterwards.
      const request = reviewed(input);
      const validation = await (options.validateToken ?? validateLocalLinkToken)(
        input.providerId,
        input.token,
      );
      await service.persistValidatedConnection(
        context,
        request,
        validation,
        input.browserOAuthToken
          ? { source: "browser-oauth", token: input.browserOAuthToken }
          : { source: "manual-token", token: input.token },
      );
      return validation;
    },
    async connectCli(
      input: ConnectionInput & { providerId: CliLinkProviderId; loginIfNeeded: boolean },
    ) {
      const request = reviewed(input);
      const provider = service.snapshot().providers.find((entry) => entry.id === input.providerId);
      if (!provider?.connectionMethods.find((method) => method.id === input.methodId)?.quickAuth)
        throw new Error("This Link connection method does not support a CLI session");
      const validation = await (options.connectCli ?? connectCliLink)(input.providerId, {
        cwd: options.cwd,
        loginIfNeeded: input.loginIfNeeded,
      });
      if (!input.label) request.label = `${provider.displayName} · ${validation.identity.label}`;
      await service.persistValidatedConnection(context, request, validation, {
        source: "cli-session",
      });
      return validation;
    },
  };
}
