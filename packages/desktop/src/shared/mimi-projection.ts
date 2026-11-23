import type {
  DesktopPetProjectionEvent,
  DesktopPetProjectionSnapshot,
  PetNavigationRequest,
  PetNavigationResult,
} from "../main/pet/pet-state-aggregator.js";

export interface MimiProjectionBaseline {
  sequence: number;
  snapshot: DesktopPetProjectionSnapshot;
}
export interface MimiProjectionUpdate {
  sequence: number;
  event: DesktopPetProjectionEvent;
  snapshot?: DesktopPetProjectionSnapshot;
}
export interface MimiProjectionOperations {
  "mimi/projectionBaseline": { input: Record<string, never>; result: MimiProjectionBaseline };
  "mimi/projectionRefresh": {
    input: { emit: boolean; full?: boolean };
    result: MimiProjectionBaseline;
  };
  "mimi/projectionNavigate": { input: PetNavigationRequest; result: PetNavigationResult };
  "mimi/projectionSources": { input: { projectCwds: string[] }; result: void };
}
