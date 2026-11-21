import type { PetTopicSegment } from "@cjhyy/code-shell-pet";
import type {
  PetDelegationClosure,
  PetSegmentTurnStart,
} from "../main/pet/pet-segment-controller.js";

export type MimiWorkCommand =
  | { type: "snapshot" }
  | { type: "clear"; sessionId: string }
  | { type: "begin"; sessionId: string; clientMessageId?: string }
  | { type: "delegation"; sessionId: string; closure: Omit<PetDelegationClosure, "turnRange"> };

export interface MimiWorkSnapshot {
  epoch: string;
  revision: number;
  segments: PetTopicSegment[];
  turn?: PetSegmentTurnStart;
}

export function mimiWorkView(segments: readonly PetTopicSegment[]) {
  return {
    activeSegmentId: segments.at(-1)?.id ?? null,
    segments: segments.flatMap((segment) =>
      segment.boundaryBeforeMessageId
        ? [
            {
              boundaryBeforeMessageId: segment.boundaryBeforeMessageId,
              ...(segment.brief ? { brief: segment.brief } : {}),
            },
          ]
        : [],
    ),
  };
}
