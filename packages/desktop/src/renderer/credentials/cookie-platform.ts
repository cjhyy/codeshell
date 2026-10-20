/** Keep account records distinct while grouping equivalent site identifiers together. */
export function cookiePlatformName(platform: string): string {
  const name = platform.toLowerCase().replace(/^www\./, "");
  if (name === "youtube" || name === "youtube.com" || name === "youtu.be") return "YouTube";
  if (name === "bilibili" || name === "bilibili.com" || name === "b23.tv") return "Bilibili";
  return platform;
}

/**
 * ID for a NEW cookie account: `platform__slug(label)`, with a numeric suffix
 * when that ID is already taken. The store upserts by ID, so reusing one would
 * replace another account's cookies and permissions (a default or non-ASCII
 * label always slugs to `account`). Existing accounts keep their IDs.
 */
export function newCookieAccountId(
  platform: string,
  label: string,
  takenIds: Iterable<string>,
): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `${platform}__${slug || "account"}`;
  const taken = new Set(takenIds);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
