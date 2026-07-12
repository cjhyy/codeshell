import type { PetApi, PetNavigationTarget, PetOpenSessionRequest } from "../../preload/types";

export interface PetNavigationAdapter {
  select(target: PetNavigationTarget): void | Promise<void>;
  onStale?(pendingStatus?: "pending" | "resolved"): void;
  onNotFound?(): void;
}

export async function openPetTarget(
  api: PetApi,
  request: PetOpenSessionRequest,
  adapter: PetNavigationAdapter,
): Promise<boolean> {
  const result = await api.openSession(request);
  if (result.status === "not-found") {
    adapter.onNotFound?.();
    return false;
  }
  await adapter.select(result.target);
  if (result.status === "stale") adapter.onStale?.(result.pendingStatus);
  return true;
}
