import type { PetFollowUpRuleView } from "../main/pet/pet-follow-up-rules.js";
import type { PetFollowUpService } from "../main/pet/pet-follow-up-service.js";

/** Facts from the native projection and rule scheduler. A renderer cannot supply this input. */
export interface MimiFollowUpView {
  registered: PetFollowUpRuleView[];
}
type ReadInput = MimiFollowUpView & { options?: Parameters<PetFollowUpService["collect"]>[0] };
export interface MimiFollowUpOperations {
  "mimi/followUps": {
    input: ReadInput;
    result: Awaited<ReturnType<PetFollowUpService["collect"]>>;
  };
  "mimi/openFollowUps": {
    input: ReadInput;
    result: Awaited<ReturnType<PetFollowUpService["listOpen"]>>;
  };
  "mimi/handleFollowUp": {
    input: MimiFollowUpView & { mutation: Parameters<PetFollowUpService["mutate"]>[0] };
    result: Awaited<ReturnType<PetFollowUpService["mutate"]>>;
  };
}
