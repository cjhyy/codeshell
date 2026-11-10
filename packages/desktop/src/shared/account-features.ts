import type { AccountFeatureSnapshot } from "@cjhyy/code-shell-web/account";
export type {
  AccountFeatureId,
  AccountFeatureMap,
  AccountFeatureView,
  AccountFeatureSnapshot,
  AccountFeaturePendingReason,
} from "@cjhyy/code-shell-web/account";
/** Shared invoke contract; events keep their separate subscription surface. */
export interface AccountFeatureIpc {
  "accountFeatures:snapshot": { args: []; result: AccountFeatureSnapshot };
  "accountFeatures:refresh": { args: [origin?: string]; result: AccountFeatureSnapshot };
}

export interface AccountFeaturesApi {
  snapshot(): Promise<AccountFeatureSnapshot>;
  refresh(origin?: string): Promise<AccountFeatureSnapshot>;
  onChanged(callback: (snapshot: AccountFeatureSnapshot) => void): () => void;
}
