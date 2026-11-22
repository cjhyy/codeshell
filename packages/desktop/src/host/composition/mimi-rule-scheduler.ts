import { join } from "node:path";
import { PetRuleScheduler, type PetRuleSchedulerDeps } from "../../main/pet/pet-rule-schedule.js";
import { PetRuleStoreError, type PetRuleStore } from "../../main/pet/pet-rule-store.js";
import type { MimiRuleCall, MimiRuleReply } from "../../shared/mimi-rules.js";
import type { CronCalls, CronCommand } from "../automation/commands.js";

type ReadScheduleMethod =
  | "load"
  | "list"
  | "claimOccurrence"
  | "settleOccurrence"
  | "recoverClaims";

export function hostedMimiRuleScheduler(input: {
  petDir: string;
  rule(call: MimiRuleCall): Promise<MimiRuleReply>;
  cron(command: CronCommand): Promise<unknown>;
  fire: PetRuleSchedulerDeps["fire"];
  report(event: string, error: unknown): void;
}) {
  const listeners = new Set<() => void>();
  const rule =
    <K extends ReadScheduleMethod>(method: K) =>
    async (...args: Parameters<PetRuleStore[K]>): Promise<Awaited<ReturnType<PetRuleStore[K]>>> => {
      const reply = await input.rule({ method, args } as MimiRuleCall);
      if (!reply.ok) throw new PetRuleStoreError(reply.code);
      return reply.value as Awaited<ReturnType<PetRuleStore[K]>>;
    };
  const cron = <K extends "petList" | "petCreate" | "petDelete">(
    method: K,
    payload: CronCalls[K]["input"],
  ) => input.cron({ method, input: payload } as CronCommand) as Promise<CronCalls[K]["result"]>;
  const coordinator = new PetRuleScheduler({
    rules: {
      load: rule("load"),
      list: rule("list"),
      claimOccurrence: rule("claimOccurrence"),
      settleOccurrence: rule("settleOccurrence"),
      recoverClaims: rule("recoverClaims"),
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    scheduler: () => ({
      list: () => cron("petList", undefined),
      create: (name, schedule, prompt, options = {}) =>
        cron("petCreate", { name, schedule, prompt, options }),
      delete: (id) => cron("petDelete", id),
    }),
    fire: input.fire,
    legacyFollowUpsPath: join(input.petDir, "follow-ups.json"),
    log: input.report,
    onError: (error) => input.report("Mimi schedule error", error),
  });
  let starting: Promise<void> | undefined;
  return {
    coordinator,
    changed() {
      for (const listener of listeners) listener();
    },
    run(command: "prepare" | "start" | "reconcile" | "stop") {
      switch (command) {
        case "prepare":
          return coordinator.prepare();
        case "start":
          return (starting ??= coordinator.start().finally(() => {
            starting = undefined;
          }));
        case "reconcile":
          return coordinator.reconcile();
        case "stop":
          coordinator.stop();
          return;
        default:
          throw Error("Invalid Mimi scheduler operation");
      }
    },
  };
}
