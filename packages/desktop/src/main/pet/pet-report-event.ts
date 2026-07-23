import { isAbsolute } from "node:path";
import type { PetReportToMimiEvent } from "@cjhyy/code-shell-pet";

export function parsePetReportToMimiEvent(value: unknown): PetReportToMimiEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const keys = Object.keys(event).sort();
  const expected = ["attachmentPaths", "createdAt", "message", "reportId", "sessionId"]
    .filter((key) => key !== "attachmentPaths" || event.attachmentPaths !== undefined)
    .sort();
  if (
    keys.length !== expected.length ||
    !keys.every((key, index) => key === expected[index]) ||
    typeof event.reportId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(event.reportId) ||
    typeof event.sessionId !== "string" ||
    event.sessionId.length < 1 ||
    event.sessionId.length > 256 ||
    event.sessionId !== event.sessionId.trim() ||
    /[\u0000-\u001f\u007f]/u.test(event.sessionId) ||
    typeof event.message !== "string" ||
    !event.message.trim() ||
    event.message.length > 8_000 ||
    !Number.isSafeInteger(event.createdAt) ||
    Number(event.createdAt) < 1
  ) {
    return null;
  }
  let attachmentPaths: string[] | undefined;
  if (event.attachmentPaths !== undefined) {
    if (
      !Array.isArray(event.attachmentPaths) ||
      event.attachmentPaths.length < 1 ||
      event.attachmentPaths.length > 4 ||
      !event.attachmentPaths.every(
        (path) =>
          typeof path === "string" && path.length > 0 && path.length <= 4_096 && isAbsolute(path),
      ) ||
      new Set(event.attachmentPaths).size !== event.attachmentPaths.length
    ) {
      return null;
    }
    attachmentPaths = [...event.attachmentPaths] as string[];
  }
  return {
    reportId: event.reportId,
    sessionId: event.sessionId,
    message: event.message.trim(),
    ...(attachmentPaths ? { attachmentPaths } : {}),
    createdAt: Number(event.createdAt),
  };
}
