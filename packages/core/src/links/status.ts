import {
  credentialAccessScope,
  getCredentialAccess,
  type CredentialAccess,
  type CredentialMetadata,
} from "../credentials/access.js";
import type { SettingsScope } from "../settings/manager.js";
import { getCliLinkStatus, isCliLinkProvider, type CliLinkStatus } from "./cli.js";
import { listLocalLinkProviders } from "./providers.js";

export interface LinkStatusOptions {
  provider?: string;
  cwd?: string;
  settingsScope?: SettingsScope;
  signal?: AbortSignal;
  /** Check installed CLIs and their current account, without starting authorization. */
  probeCli?: boolean;
}

export interface LinkStatusDependencies {
  credentialAccess?: Pick<CredentialAccess, "listMasked" | "listMaskedWithStatus">;
  getCliStatus?: typeof getCliLinkStatus;
}

export interface LinkConnectionStatus {
  id: string;
  account?: string;
  backend: "http-token" | "cli" | "oauth";
  runtime?: "local" | "server";
  verifiedAt?: string;
  /** Metadata readiness only; this does not revalidate a token or a CLI account binding. */
  state: "ready" | "unavailable" | "expired" | "invalid";
  reason?: string;
}

export type LinkCliStatus =
  | (CliLinkStatus & { state: "checked" })
  | {
      state: "skipped";
      reasonCode: "unsupported" | "scope" | "disabled";
      reason: string;
    }
  | { state: "error"; reason: string };

export interface LinkProviderStatus {
  id: string;
  name: string;
  connections: LinkConnectionStatus[];
  cli: LinkCliStatus;
}

export interface LinkStatusResult {
  kind: "link_status";
  checkedAt: string;
  credentialStore: { state: "checked" | "error"; reason?: string };
  providers: LinkProviderStatus[];
  guidance: string;
}

const GUIDANCE =
  "Saved connection readiness describes stored metadata, not live token validity or a CLI " +
  "account binding check. Check runtime: LinkAction handles registered local actions and " +
  "rechecks access when used; server OAuth connections use their configured server/MCP tools. " +
  "A CLI login can exist without " +
  "a usable saved Link: use the provider CLI under normal tool permissions, or reconnect the " +
  "Link in Credentials → Link. UseCredential omits Link credentials and cannot prove logout. " +
  "A failed CLI check may be a network or service failure, not a signed-out account.";

// Do not return entire CredentialMetadata objects, even though they are called
// masked: they can contain secret hints and unrelated provider metadata.
function connectionStatus(credential: CredentialMetadata): LinkConnectionStatus {
  const meta = credential.meta;
  const result: LinkConnectionStatus = {
    id: credential.id,
    account: meta?.linkAccountLabel,
    backend: meta?.linkExecutionBackend ?? (credential.type === "oauth" ? "oauth" : "http-token"),
    runtime: meta?.linkExecutionRuntime ?? (credential.type === "oauth" ? "server" : undefined),
    verifiedAt: meta?.linkLastVerifiedAt,
    state: "ready",
  };
  if (!credential.hasSecret || credential.oauthStatus?.state === "missing") {
    result.state = "unavailable";
    result.reason = "Saved credential is missing or cannot be read. Reconnect this Link.";
  } else if (credential.oauthStatus?.state === "expired") {
    result.state = "expired";
    result.reason = "Saved authorization has expired. Reconnect this Link.";
  } else if (credential.oauthStatus?.state === "invalid") {
    result.state = "invalid";
    result.reason = "Saved authorization is invalid. Reconnect this Link.";
  } else if (!result.runtime) {
    result.state = "unavailable";
    result.reason = "Saved Link has no execution runtime. Reconnect it to enable local LinkAction.";
  } else if (meta?.linkExecutionBackend === "cli" && !meta.linkAccountId) {
    result.state = "invalid";
    result.reason = "Saved CLI connection has no account binding. Reconnect this Link.";
  }
  return result;
}

function credentialProvider(credential: CredentialMetadata): string | undefined {
  if (credential.type !== "link" && credential.type !== "oauth") return undefined;
  // Match the Link page, including OAuth records saved before provider metadata
  // was introduced. An arbitrary MCP credential is included only if its provider
  // matches the supported Link catalog below.
  return (
    credential.meta?.linkProvider ||
    credential.meta?.oauthProvider ||
    (credential.id.endsWith("-oauth") ? credential.id.slice(0, -"-oauth".length) : undefined)
  );
}

/** CLI diagnostics may echo environment values or tokens. Return fixed reasons only. */
function cliFailureMessage(status: CliLinkStatus): string {
  if (!status.installed) return `${status.command} is not installed`;
  const message = status.message ?? "";
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(message)) {
    return "CLI status check timed out; login state could not be confirmed.";
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ECONN|network|DNS|socket|fetch failed|connection|TLS|certificate/i.test(
      message,
    )
  ) {
    return "CLI status check could not reach the provider; login state could not be confirmed.";
  }
  if (
    /not (?:signed|logged) in|not authenticated|authentication|unauthorized|invalid.*token|\b401\b/i.test(
      message,
    )
  ) {
    return "CLI authentication was not accepted. Check the CLI account or reconnect this Link.";
  }
  return "CLI login could not be confirmed. Check the provider CLI status for details.";
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Link status check cancelled", "AbortError");
}

/** Read stored connections and live CLI status without resolving, refreshing, or saving credentials. */
export async function getLinkStatus(
  options: LinkStatusOptions = {},
  dependencies: LinkStatusDependencies = {},
): Promise<LinkStatusResult> {
  throwIfCancelled(options.signal);
  const providerId = options.provider?.trim().toLowerCase();
  const catalog = listLocalLinkProviders();
  if (providerId && !catalog.some((provider) => provider.id === providerId)) {
    throw new Error(`Unknown local Link provider: ${providerId}`);
  }
  const selected = providerId ? catalog.filter((provider) => provider.id === providerId) : catalog;
  let credentials: CredentialMetadata[] = [];
  const credentialStore: LinkStatusResult["credentialStore"] = { state: "checked" };
  try {
    const access = dependencies.credentialAccess ?? getCredentialAccess();
    const cwd = options.cwd ?? process.cwd();
    const scope = credentialAccessScope(options.settingsScope);
    if (access.listMaskedWithStatus) {
      const snapshot = access.listMaskedWithStatus(cwd, scope);
      credentials = snapshot.credentials;
      if (!snapshot.readable) credentialStore.state = "error";
    } else {
      credentials = access.listMasked(cwd, scope);
    }
  } catch {
    credentialStore.state = "error";
  }
  if (credentialStore.state === "error") {
    credentialStore.reason =
      "Saved Link credentials could not be read; connection state is unknown.";
  }
  throwIfCancelled(options.signal);

  const providers = new Array<LinkProviderStatus>(selected.length);
  let nextIndex = 0;
  // Five providers currently have a CLI adapter. Bound subprocess/network work
  // so an all-provider check cannot fan out without limit as the catalog grows.
  await Promise.all(
    Array.from({ length: Math.min(3, selected.length) }, async () => {
      while (nextIndex < selected.length) {
        throwIfCancelled(options.signal);
        const index = nextIndex++;
        const provider = selected[index]!;
        const connections = credentials
          .filter((credential) => credentialProvider(credential) === provider.id)
          .map(connectionStatus);
        let cli: LinkCliStatus;
        if (!isCliLinkProvider(provider.id)) {
          cli = {
            state: "skipped",
            reasonCode: "unsupported",
            reason: "This provider has no supported CLI status check.",
          };
        } else if (options.settingsScope && options.settingsScope !== "full") {
          cli = {
            state: "skipped",
            reasonCode: "scope",
            reason: "Host CLI login checks are unavailable in project or isolated settings scope.",
          };
        } else if (options.probeCli === false) {
          cli = {
            state: "skipped",
            reasonCode: "disabled",
            reason: "CLI status check was disabled for this request.",
          };
        } else {
          try {
            const status = await (dependencies.getCliStatus ?? getCliLinkStatus)(provider.id, {
              cwd: options.cwd,
              signal: options.signal,
            });
            throwIfCancelled(options.signal);
            cli = {
              state: "checked",
              providerId: status.providerId,
              command: status.command,
              installed: status.installed,
              authenticated: status.authenticated,
              ...(status.authenticated && status.account ? { account: status.account } : {}),
              ...(!status.authenticated ? { message: cliFailureMessage(status) } : {}),
            };
          } catch {
            throwIfCancelled(options.signal);
            cli = { state: "error", reason: "CLI status check failed; login state is unknown." };
          }
        }
        providers[index] = { id: provider.id, name: provider.displayName, connections, cli };
      }
    }),
  );
  throwIfCancelled(options.signal);
  return {
    kind: "link_status",
    checkedAt: new Date().toISOString(),
    credentialStore,
    providers,
    guidance: GUIDANCE,
  };
}
