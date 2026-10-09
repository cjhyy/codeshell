import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OperationReviewStore } from "../operations/review-store.js";
import type { OperationSessionOwner } from "../operations/session-owner.js";

/** Host-only Link adapter for existing activity review; provider semantics stay outside generic operations. */
export function createLinkOperationReviewStore(root: string): OperationReviewStore {
  return new OperationReviewStore(root, legacyLinkOperationEvidence);
}

/** Legacy ownership needs actual matching receipts in this incarnation's bounded transcript. */
export function legacyLinkOperationEvidence(owner: OperationSessionOwner): Map<string, string> {
  const result = new Map<string, string>();
  let fd: number | undefined;
  try {
    fd = openSync(
      join(owner.directory, "transcript.jsonl"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > 8 * 1024 * 1024) return result;
    const events = readFileSync(fd, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const meta = events.find((event) => event.type === "session_meta");
    if (meta?.data?.startedAt !== owner.startedAt || meta.data.sessionId !== owner.state.sessionId)
      return result;
    const calls = new Map(
      events
        .filter((event) => event.type === "tool_use" && event.data?.toolName === "LinkAction")
        .map((event) => [event.data.toolCallId, event.data.args]),
    );
    for (const event of events) {
      if (
        event.type !== "tool_result" ||
        event.data?.toolName !== "LinkAction" ||
        typeof event.data?.result !== "string"
      )
        continue;
      let output;
      try {
        output = JSON.parse(event.data.result);
      } catch {
        continue;
      }
      const receipt = output?.operation;
      const call = calls.get(event.data.toolCallId);
      if (
        call?.provider !== "github" ||
        call.action !== output.action ||
        output.kind !== "unverified_write" ||
        output.untrustedExternalContent !== true ||
        output.provider !== "github" ||
        !receipt ||
        !receipt.attemptId ||
        !["create_issue", "set_starred", "update_issue"].includes(output.action)
      )
        continue;
      result.set(
        receipt.id,
        JSON.stringify([receipt.owner, receipt.fingerprint, receipt.attemptId]),
      );
    }
  } catch {
    return new Map();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return result;
}
