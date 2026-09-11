/** Validate the host envelope without changing the domain-neutral stream payload. */
export function normalizeStreamEnvelope(value: unknown): {
  sessionId: string;
  event: Record<string, unknown>;
  seq?: number;
  epoch?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const event = input.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const payload = event as Record<string, unknown>;
  if (typeof payload.type !== "string" || !payload.type) return null;
  return {
    sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
    event: payload,
    ...(typeof input.seq === "number" && Number.isSafeInteger(input.seq) && input.seq > 0
      ? { seq: input.seq }
      : {}),
    ...(typeof input.epoch === "string" && input.epoch ? { epoch: input.epoch } : {}),
  };
}
