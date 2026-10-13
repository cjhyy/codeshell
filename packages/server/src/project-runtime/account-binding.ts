/** Explicit single-operator adoption; account display names never confer ownership. */
export interface CloudAccountBinding {
  version: 1;
  accountOrigin: string;
  accountId: string;
  ownerId: string;
  managementEpoch: string;
  createdAt: number;
}

/** Fresh installation policy. Each verified Account receives its own internal owner. */
export interface CloudMultiAccountConfiguration {
  accountOrigin: string;
  managementEpoch: string;
}

export const CLOUD_ADOPTION_PENDING = "account-adoption-pending.json";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function isCloudAccountOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export function isCloudAccountBinding(value: unknown): value is CloudAccountBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as CloudAccountBinding;
  return (
    Object.keys(row).sort().join() ===
      ["version", "accountOrigin", "accountId", "ownerId", "managementEpoch", "createdAt"]
        .sort()
        .join() &&
    row.version === 1 &&
    isCloudAccountOrigin(row.accountOrigin) &&
    UUID.test(row.accountId) &&
    UUID.test(row.ownerId) &&
    UUID.test(row.managementEpoch) &&
    Number.isSafeInteger(row.createdAt) &&
    row.createdAt >= 0
  );
}

export function isCloudMultiAccountConfiguration(
  value: unknown,
): value is CloudMultiAccountConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as CloudMultiAccountConfiguration;
  return (
    Object.keys(row).sort().join() === "accountOrigin,managementEpoch" &&
    isCloudAccountOrigin(row.accountOrigin) &&
    typeof row.managementEpoch === "string" &&
    UUID.test(row.managementEpoch)
  );
}
