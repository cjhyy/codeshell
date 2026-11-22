import { expect, test } from "bun:test";
import type { DesktopPetSession } from "../pet/pet-state-aggregator.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";
import { nativeMimiExternalActivity } from "./mimi-external-client.js";

test("new Host replaces a pending generation and failed visibility refresh removes old rows", async () => {
  const starting = Promise.withResolvers<void>();
  const suspended = Promise.withResolvers<DesktopPetSession[]>();
  const row = (agentSessionId: string) => ({ agentSessionId }) as DesktopPetSession;
  const replies: (() => Promise<DesktopPetSession[]>)[] = [
    async () => [row("first")],
    () => {
      starting.resolve();
      return suspended.promise;
    },
    async () => [row("replacement")],
    async () => {
      throw Error("history unavailable");
    },
  ];
  const changes: string[] = [];
  const listeners = new Set<() => void>();
  const service = nativeMimiExternalActivity(
    (async () => replies.shift()!()) as CallShellBusiness,
    listeners,
    async () => [],
    {
      upsertExternalSession: (r) => changes.push("+" + r.agentSessionId),
      removeExternalSession: (id) => changes.push("-" + id),
    },
  );
  await service.reconcile();
  for (const listener of listeners) listener();
  await starting.promise;
  const restarted = service.restart();
  suspended.resolve([row("retired")]);
  await restarted;
  await expect(service.reconcile()).rejects.toThrow("history unavailable");
  expect(changes).toEqual(["+first", "-first", "+replacement", "-replacement"]);
  service.shutdown();
  expect(listeners.size).toBe(0);
});
