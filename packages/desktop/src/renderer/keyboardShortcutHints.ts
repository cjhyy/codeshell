/** Display the primary modifier from the platform supplied by preload. */
export function formatModifierShortcut(
  platform: string | undefined,
  keys: string,
  style: "text" | "symbol" = "text",
): string {
  const modifier = platform === "darwin" ? (style === "symbol" ? "⌘" : "Cmd+") : "Ctrl+";
  return `${modifier}${keys}`;
}
