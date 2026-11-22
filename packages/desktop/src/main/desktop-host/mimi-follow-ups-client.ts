import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import type { PetFollowUpService, RegisteredFollowUps } from "../pet/pet-follow-up-service.js";

export function nativeMimiFollowUps(
  call: CallShellBusiness,
  registered: RegisteredFollowUps,
): PetFollowUpService {
  async function view(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await registered.load();
    signal?.throwIfAborted();
    return { registered: registered.list() };
  }
  return {
    collect: async (options, signal) =>
      call("mimi/followUps", { ...(await view(signal)), options }, signal),
    listOpen: async (options, signal) =>
      call("mimi/openFollowUps", { ...(await view(signal)), options }, signal),
    mutate: async (mutation, signal) =>
      call("mimi/handleFollowUp", { ...(await view(signal)), mutation }, signal),
  };
}
