/** Browser-safe account policy. No credentials, network or host state lives here. */
export const ACCOUNT_FEATURE_IDS = [
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
] as const;
export type AccountFeatureId = (typeof ACCOUNT_FEATURE_IDS)[number];
export type AccountFeatureReason = "not_configured" | "not_entitled" | "disabled_by_operator";
export type AccountFeaturePendingReason =
  | "device_not_registered"
  | "relay_connecting"
  | "relay_disconnected"
  | "service_unreachable"
  | "storage_error";
export interface AccountFeature {
  version: number;
  enabled: boolean;
  reason?: AccountFeatureReason;
  params?: { cloudOrigin?: string };
}
export type AccountFeatureMap = Partial<Record<AccountFeatureId, AccountFeature>>;
export interface AccountFeatureView {
  id: AccountFeatureId;
  state: "hidden" | "sign-in" | "pending" | "ready";
  reason?: AccountFeaturePendingReason;
  params?: { cloudOrigin?: string };
}
export type AccountFeatureSnapshot = Record<AccountFeatureId, AccountFeatureView>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function isAccountFeatureId(value: unknown): value is AccountFeatureId {
  return typeof value === "string" && (ACCOUNT_FEATURE_IDS as readonly string[]).includes(value);
}
/** Only canonical HTTPS origins are passed between hosts; local dev may use loopback HTTP. */
export function accountPublicOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}
export function accountRegistrationUrl(origin: string): string {
  const safe = accountPublicOrigin(origin);
  if (!safe) throw new Error("Invalid account service origin");
  return `${safe}/register`;
}
/** Missing, malformed or unsupported feature declarations fail closed. */
export function parseAccountFeatures(raw: unknown): AccountFeatureMap {
  const input = object(raw);
  const result: AccountFeatureMap = {};
  if (!input) return result;
  for (const id of ACCOUNT_FEATURE_IDS) {
    const entry = object(input[id]);
    if (!entry || entry.version !== 1 || typeof entry.enabled !== "boolean") continue;
    const feature: AccountFeature = { version: 1, enabled: entry.enabled };
    if (["not_configured", "not_entitled", "disabled_by_operator"].includes(entry.reason as string))
      feature.reason = entry.reason as AccountFeatureReason;
    if (id === "cloud.projects" && entry.enabled) {
      const origin = accountPublicOrigin(object(entry.params)?.cloudOrigin);
      if (!origin) continue;
      feature.params = { cloudOrigin: origin };
    }
    result[id] = feature;
  }
  return result;
}
/** Deployment and account responses share the same explicit feature contract. */
export function readAccountFeatures(payload: unknown): AccountFeatureMap {
  return parseAccountFeatures(object(payload)?.features);
}
export interface ResolveAccountFeaturesInput {
  deployment?: AccountFeatureMap;
  account?: AccountFeatureMap;
  signedIn: boolean;
  supported?: readonly AccountFeatureId[];
  reachable?: boolean;
  storageError?: boolean;
  local?: Partial<
    Record<AccountFeatureId, { ready: boolean; reason?: AccountFeaturePendingReason }>
  >;
}
export function resolveAccountFeatures(input: ResolveAccountFeaturesInput): AccountFeatureSnapshot {
  const snapshot = {} as AccountFeatureSnapshot;
  for (const id of ACCOUNT_FEATURE_IDS) {
    const view: AccountFeatureView = { id, state: "hidden" };
    snapshot[id] = view;
    const deployment = input.deployment?.[id];
    if (
      (input.supported && !input.supported.includes(id)) ||
      deployment?.version !== 1 ||
      !deployment.enabled
    )
      continue;
    const account = input.account?.[id];
    if (input.signedIn && input.account && (account?.version !== 1 || !account.enabled)) continue;
    const feature = input.signedIn && account ? account : deployment;
    if (feature.params) view.params = { ...feature.params };
    if (input.storageError) {
      view.state = "pending";
      view.reason = "storage_error";
    } else if (!input.signedIn) {
      view.state = "sign-in";
    } else if (input.reachable === false || !input.account) {
      view.state = "pending";
      view.reason = "service_unreachable";
    } else if (input.local?.[id]?.ready === false) {
      view.state = "pending";
      view.reason = input.local[id]?.reason ?? "service_unreachable";
    } else view.state = "ready";
  }
  return snapshot;
}
