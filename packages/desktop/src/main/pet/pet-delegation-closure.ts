import type { PetDelegationClosure } from "./pet-segment-controller.js";

export interface PetDelegationClosureSink {
  onDelegationClosed(closure: PetDelegationClosure): Promise<void>;
}

/** Work-memory distillation is repairable and must not block closure delivery. */
export async function recordPetDelegationClosureBestEffort(
  sink: PetDelegationClosureSink | null,
  closure: PetDelegationClosure,
  onError: (error: unknown) => void,
): Promise<boolean> {
  try {
    if (!sink) throw new Error("Pet work-memory sink is not ready");
    await sink.onDelegationClosed(closure);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}
