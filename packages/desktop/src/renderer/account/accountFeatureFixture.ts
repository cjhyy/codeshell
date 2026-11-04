import type {
  AccountFeatureId,
  AccountFeatureSnapshot,
  AccountFeatureView,
} from "../../shared/account-features.js";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
const ids: AccountFeatureId[] = [
  "links.remote",
  "cloud.projects",
  "relay.phone",
  "devices.dispatch",
  "devices.directory",
  "devices.handoff",
  "notify.push",
  "sync.preferences",
  "sync.mimi",
  "sync.history",
  "market.publish",
  "characters.licensed",
  "cloud.fallback",
];
export function featureSnapshot(
  state: AccountFeatureView["state"] = "ready",
  params?: AccountFeatureView["params"],
): AccountFeatureSnapshot {
  return Object.fromEntries(
    ids.map((id) => [id, { id, state, ...(params ? { params } : {}) }]),
  ) as AccountFeatureSnapshot;
}
export function featureBridge(
  state: AccountFeatureView["state"] = "ready",
  params?: AccountFeatureView["params"],
) {
  const snapshot = featureSnapshot(state, params);
  return {
    snapshot: async () => snapshot,
    refresh: async () => snapshot,
    onChanged: () => () => {},
  };
}
export function accountFeatureBridge(
  account: Pick<NonNullable<Window["codeshell"]>["cloudAccount"], "status" | "onStatus">,
) {
  let latest: AccountFeatureSnapshot | undefined;
  const project = (status: CloudAccountStatus) =>
    featureSnapshot(
      status.state === "signed-in" && status.origin && status.account?.id ? "ready" : "hidden",
    );
  const snapshot = async () => {
    if (latest) return latest;
    const read = project(await account.status());
    return latest ?? read;
  };
  return {
    snapshot,
    refresh: snapshot,
    onChanged: (apply: (snapshot: AccountFeatureSnapshot) => void) =>
      account.onStatus((status) => {
        latest = project(status);
        apply(latest);
      }),
  };
}
