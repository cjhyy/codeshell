/** Shared browser-safe profile rules. ZWJ/ZWNJ and combining emoji remain valid. */
export function normalizeCloudDisplayName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    /[\p{Cc}\p{Cs}\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)
  )
    return;
  const normalized = value.trim().normalize("NFC");
  if (
    !normalized ||
    Array.from(normalized).length > 64 ||
    /[\p{Cc}\p{Cs}\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(normalized)
  )
    return;
  return normalized;
}

export function normalizeCloudUsername(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized) ? normalized : undefined;
}
