/** Owner controls for an already registered follow-up. Registration stays with Mimi. */
export type PetFollowUpControlRequest =
  | {
      action: "cancel" | "complete" | "dismiss";
      followUpId: string;
      expectedRevision: number;
    }
  | {
      action: "reschedule";
      followUpId: string;
      expectedRevision: number;
      wakeAt: number;
      timezone: string;
    };
