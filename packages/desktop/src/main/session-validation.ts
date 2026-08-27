export function assertDesktopSessionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new Error("invalid desktop sessionId");
  }
}
