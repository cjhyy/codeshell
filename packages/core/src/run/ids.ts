function assertSafeRunSegment(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}: must be a non-empty string`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`invalid ${label}: contains path separator: ${value}`);
  }
  if (value === "." || value === ".." || value.includes("..")) {
    throw new Error(`invalid ${label}: contains parent-dir token: ${value}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`invalid ${label}: unexpected characters: ${value}`);
  }
  if (value.length > 128) {
    throw new Error(`invalid ${label}: too long (max 128 chars)`);
  }
}

export function assertSafeRunId(runId: unknown): asserts runId is string {
  assertSafeRunSegment(runId, "run id");
}

export function assertSafeRunFileId(value: unknown, label: string): asserts value is string {
  assertSafeRunSegment(value, label);
}
