export type {
  LinkAuthorization,
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
}
