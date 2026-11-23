import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import {
  mimiWorkView,
  type MimiWorkCommand,
  type MimiWorkSnapshot,
} from "../../shared/mimi-work-memory.js";
import type {
  PetDelegationClosure,
  PetSegmentClosed,
  PetSegmentControllerOptions,
} from "../pet/pet-segment-controller.js";

export function nativeMimiWorkMemory(business: CallShellBusiness) {
  let latest: MimiWorkSnapshot = { epoch: "", revision: 0, segments: [] };
  const run = async (input: MimiWorkCommand) => {
    const result = await business("mimi/workMemory", input);
    if (latest.epoch !== result.epoch || latest.revision <= result.revision) latest = result;
    return result;
  };
  const segmentBoundaries = () => mimiWorkView(latest.segments).segments;
  return {
    load: () => run({ type: "snapshot" }),
    activeSegment: () => latest.segments.at(-1),
    allSegments: () => latest.segments,
    segmentBoundaries,
    controller({
      petSessionId: sessionId,
      archiveRange,
      onSegmentClosed,
    }: Pick<PetSegmentControllerOptions, "petSessionId" | "archiveRange" | "onSegmentClosed">) {
      return {
        segmentBoundaries,
        requestContextClear: async () => {
          await run({ type: "clear", sessionId });
        },
        beginTurn: async (clientMessageId?: string) =>
          (await run({ type: "begin", sessionId, clientMessageId })).turn,
        completeSegmentClosure: async (closed: PetSegmentClosed) => {
          await onSegmentClosed?.(closed);
        },
        onDelegationClosed: async ({ turnRange, ...closure }: PetDelegationClosure) => {
          await run({ type: "delegation", sessionId, closure });
          if (turnRange) await archiveRange(sessionId, turnRange);
        },
      };
    },
  };
}
