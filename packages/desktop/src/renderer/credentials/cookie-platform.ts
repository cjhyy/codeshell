/** Keep account records distinct while grouping equivalent site identifiers together. */
export function cookiePlatformName(platform: string): string {
  const name = platform.toLowerCase().replace(/^www\./, "");
  if (name === "youtube" || name === "youtube.com" || name === "youtu.be") return "YouTube";
  if (name === "bilibili" || name === "bilibili.com" || name === "b23.tv") return "Bilibili";
  return platform;
}
