import type { PetRuleSchedulerDeps } from "../pet/pet-rule-schedule.js";
import type { CallShellBusiness } from "../../shared/shell-business-contracts.js";

/** Native power events and already-claimed notification effects. Occurrence ownership stays in Host. */
export class NativeMimiScheduler {
  private fire?: PetRuleSchedulerDeps["fire"];
  private started = false;
  private readonly onPower = () => {
    if (this.started) void this.call("mimi/ruleScheduler", "reconcile").catch(this.report);
  };
  constructor(
    private readonly call: CallShellBusiness,
    private readonly power: NonNullable<PetRuleSchedulerDeps["powerEvents"]>,
    private readonly report: (error: unknown) => void,
  ) {}
  configure(fire: PetRuleSchedulerDeps["fire"]) {
    this.fire = fire;
    return {
      prepare: () => this.call("mimi/ruleScheduler", "prepare"),
      start: async () => {
        if (!this.started) {
          this.started = true;
          this.power.on("resume", this.onPower);
          this.power.on("unlock-screen", this.onPower);
        }
        await this.call("mimi/ruleScheduler", "start");
      },
      stop: () => {
        this.started = false;
        this.fire = undefined;
        this.power.removeListener("resume", this.onPower);
        this.power.removeListener("unlock-screen", this.onPower);
        void this.call("mimi/ruleScheduler", "stop").catch(this.report);
      },
    };
  }
  reconnect() {
    if (this.started) void this.call("mimi/ruleScheduler", "start").catch(this.report);
  }
  effect(...args: Parameters<PetRuleSchedulerDeps["fire"]>) {
    if (!this.fire) throw Error("Mimi notification services unavailable");
    return this.fire(...args);
  }
}
