import type { AccountFeatureSnapshot } from "@cjhyy/code-shell-web/account";
export type {
  AccountFeatureId,
  AccountFeatureMap,
  AccountFeatureView,
  AccountFeatureSnapshot,
  AccountFeaturePendingReason,
} from "@cjhyy/code-shell-web/account";
export interface AccountFeaturesApi {
  snapshot(): Promise<AccountFeatureSnapshot>;
  refresh(origin?: string): Promise<AccountFeatureSnapshot>;
  onChanged(callback: (snapshot: AccountFeatureSnapshot) => void): () => void;
}
