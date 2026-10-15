export type {
  LinkAuthorization,
  LinkAuthorizationFailure,
  LinkAuthMode,
  LinkAuthorizationInput,
  LinkAuthorizationResponse,
  LinkAuthorizationStep,
  LinkConnectionInput,
  LinkErrorCode,
  LinkSnapshot,
  MaskedLinkConnection,
  TokenConnectionInput,
} from "@cjhyy/code-shell-link";

export interface LinkOperationContext {
  ownerId: string;
  /** Rechecked after every external await and immediately before persistence. */
  authorize: () => boolean | Promise<boolean>;
  /** Native Host request lifetime; never accepted from the remote request body. */
  signal?: AbortSignal;
}

/** Trusted Host integration. Secrets and registration settings never enter browser inputs. */
export interface HostLinkOAuthAdapter {
  providerId: string;
  methodId: string;
  authModeId: string;
  label: string;
  authorize(input: {
    id: string;
    label: string;
    previous: import("@cjhyy/code-shell-core").Credential | null;
    signal: AbortSignal;
    onAuthorizationUrl(url: string, expiresAt: string): Promise<void>;
  }): Promise<import("@cjhyy/code-shell-core").Credential>;
  /** The adapter owns its callback listener; the native browser must not bind it again. */
  openAuthorizationUrl(url: string): Promise<void>;
  /** Called after local authority is removed; must not delete a subsequently reconnected record. */
  disconnect?(credential: import("@cjhyy/code-shell-core").Credential): Promise<void>;
}
