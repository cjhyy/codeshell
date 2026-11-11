import { rm, stat } from "node:fs/promises";
import type { CronJob, CronScheduler } from "@cjhyy/code-shell-core/internal";
import type { PetNoticePowerEvents } from "./pet-notice-decision-hooks.js";
import { isScheduleRule, type PetRuleStore, type ScheduleNoticeRule } from "./pet-rule-store.js";
import {
  dueAt,
  occurrenceDeadline,
  WAKE_DETAIL_MAX,
  type RuleWakeOutcome,
} from "./pet-schedule-rule.js";

/**
 * Executor of time-triggered rules (design §4.1 `schedule`, §10.1). The rule
 * table is the only record of WHEN; each rule's current occurrence is
 * projected into the core scheduler as one absolute one-shot job, which is a
 * rebuildable trigger and nothing more.
 *
 * - Job identity `mimi-follow-up:rule:<ruleId>:<version>:<occurrence>`: an
 *   edit (new version) or a repeating rule moving on (new occurrence) retires
 *   the old job, and a stale timer callback fails the durable claim. The
 *   `mimi-follow-up:` namespace is one older builds already keep away from
 *   automations: after a downgrade they neither list nor run these jobs as
 *   headless turns (they reject and delete them; this build rebuilds them).
 * - The claim is written before any effect; an effect that throws is
 *   recorded `unknown` and never retried; a claim that outlived its process
 *   is recovered as `unknown` at startup.
 * - Past-due occurrences are never handed to the core scheduler (it treats a
 *   cold start as a miss and its timers can sleep through a laptop's sleep):
 *   every reconcile — at start, on any rule change, on resume / unlock —
 *   handles them here. `fire-once` fires one catch-up inside the deadline,
 *   `skip` only within the scheduler's 90 s grace; a repeating rule replays
 *   at most its latest missed occurrence.
 */

/** Every Mimi schedule job, old and new, lives under this namespace. */
const NAMESPACE = "mimi-follow-up:";
const PREFIX = `${NAMESPACE}rule:`;
/** Keys an unreleased pre-review build of this scheduler used; retired like the old store's. */
const PRE_REVIEW_PREFIX = "mimi-rule:";
const KEY_PATTERN =
  /^mimi-follow-up:rule:(rule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+):(\d+)$/u;
const JOB_PROMPT = "Mimi scheduled rule";
const JOB_NAME_MAX = 512;
/** The core scheduler's misfire grace: later than this, a `skip` occurrence is missed. */
const MISFIRE_GRACE_MS = 90_000;
const MISSED_ONCE = "已错过约定时间或补发期限，未自动执行。请重新改期。";
const MISSED_REPEAT = "错过了一次（电脑睡眠或未运行），未补发；之后按时提醒。";

export function ruleScheduleKey(id: string, version: number, occurrence: number): string {
  return `${PREFIX}${id}:${version}:${occurrence}`;
}

/** Jobs owned by Mimi's schedule rules (and the retired follow-up store's): not automations. */
export function isPetRuleScheduleJob(job: Pick<CronJob, "creationKey">): boolean {
  const key = job.creationKey ?? "";
  return key.startsWith(NAMESPACE) || key.startsWith(PRE_REVIEW_PREFIX);
}

/** A job of the follow-up store this replaced (or of a pre-review build), retired at startup. */
function isLegacyJob(job: Pick<CronJob, "creationKey">): boolean {
  return isPetRuleScheduleJob(job) && !job.creationKey!.startsWith(PREFIX);
}

export interface RuleScheduleDue {
  occurrence: number;
  /** Last instant the occurrence may still be delivered. */
  deadline: number;
  /** Stable identity of this occurrence (Notice dedupe key). */
  key: string;
}

export interface PetRuleSchedulerDeps {
  rules: Pick<
    PetRuleStore,
    "load" | "list" | "onChange" | "claimOccurrence" | "settleOccurrence" | "recoverClaims"
  >;
  scheduler(): Pick<CronScheduler, "list" | "create" | "delete">;
  /** Carry out one claimed occurrence (`remind` / `run-mimi`). Throwing records `unknown`. */
  fire(rule: ScheduleNoticeRule, due: RuleScheduleDue): Promise<RuleWakeOutcome>;
  /** Electron `powerMonitor`: occurrences slept through are handled on wake / unlock. */
  powerEvents?: Pick<PetNoticePowerEvents, "on" | "removeListener">;
  /** The old `follow-ups.json`, deleted at startup (its data is not migrated). */
  legacyFollowUpsPath?: string;
  now?: () => number;
  onError?(error: unknown): void;
  log?(event: string, data: Record<string, unknown>): void;
}

export class PetRuleScheduler {
  private reconcileTail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();
  private unsubscribe?: () => void;
  private started = false;
  private preparation?: Promise<void>;
  private repairTimer?: ReturnType<typeof setTimeout>;
  private repairDelay = 1_000;
  private legacyRetired = false;
  private readonly onPower = () => {
    void this.reconcile().catch((error) => this.deps.onError?.(error));
  };

  constructor(private readonly deps: PetRuleSchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Load the rules and record surviving claims as `unknown`, before anything fires. */
  prepare(): Promise<void> {
    return (this.preparation ??= this.deps.rules
      .load()
      .then(async () => {
        await this.deps.rules.recoverClaims();
      })
      .catch((error) => {
        this.preparation = undefined;
        throw error;
      }));
  }

  /**
   * Start firing. Never throws for a store that cannot load: follow-ups then
   * stay off (logged) and the rest of the app starts normally.
   */
  async start(): Promise<void> {
    if (this.started) return;
    try {
      await this.prepare();
    } catch (error) {
      this.deps.log?.("pet.followUp.scheduler_off", { error: String(error) });
      this.deps.onError?.(error);
      return;
    }
    this.started = true;
    this.unsubscribe = this.deps.rules.onChange(() => {
      void this.reconcile().catch((error) => this.deps.onError?.(error));
    });
    this.deps.powerEvents?.on("resume", this.onPower);
    this.deps.powerEvents?.on("unlock-screen", this.onPower);
    await this.retireLegacy();
    await this.reconcile();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.deps.powerEvents?.removeListener("resume", this.onPower);
    this.deps.powerEvents?.removeListener("unlock-screen", this.onPower);
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
  }

  /** Occurrences being carried out right now (tests and shutdown wait on them). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Retry a failed projection with backoff; claimed or settled occurrences never re-fire. */
  repairSoon(): void {
    if (!this.started || this.repairTimer) return;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = undefined;
      this.repairDelay = Math.min(30_000, this.repairDelay * 2);
      void this.reconcile().catch((error) => this.deps.onError?.(error));
    }, this.repairDelay);
    this.repairTimer.unref?.();
  }

  /** Project future occurrences into jobs; handle past-due ones here. */
  reconcile(): Promise<void> {
    const next = this.reconcileTail
      .catch(() => undefined)
      .then(() => {
        if (!this.started) return;
        const scheduler = this.deps.scheduler();
        const now = this.now();
        const desired = new Map<string, ScheduleNoticeRule>();
        for (const rule of this.deps.rules.list()) {
          if (!isScheduleRule(rule) || rule.state !== "active" || rule.wake.status !== "scheduled")
            continue;
          if (dueAt(rule.wake) <= now) {
            this.track(this.handleDue(rule.id, rule.version, rule.wake.occurrence));
            continue;
          }
          desired.set(ruleScheduleKey(rule.id, rule.version, rule.wake.occurrence), rule);
        }
        const kept = new Set<string>();
        for (const job of scheduler.list()) {
          if (!job.creationKey?.startsWith(PREFIX)) continue;
          const rule = desired.get(job.creationKey);
          if (rule && !kept.has(job.creationKey) && this.matches(job, rule)) {
            kept.add(job.creationKey);
            continue;
          }
          scheduler.delete(job.id);
        }
        for (const [key, rule] of desired) {
          if (kept.has(key)) continue;
          scheduler.create(rule.then.title.slice(0, JOB_NAME_MAX), "once", JOB_PROMPT, {
            once: true,
            ...this.timing(rule),
            creationKey: key,
          });
        }
      });
    const repaired = next
      .then(() => {
        this.repairDelay = 1_000;
      })
      .catch((error) => {
        this.repairSoon();
        throw error;
      });
    this.reconcileTail = repaired;
    return repaired;
  }

  /** A job came due (the runner routed it here). */
  async wake(job: Pick<CronJob, "creationKey">): Promise<void> {
    const parsed = KEY_PATTERN.exec(job.creationKey ?? "");
    if (!parsed) {
      if (isLegacyJob(job)) return;
      throw new Error("invalid schedule rule wake identity");
    }
    await this.prepare();
    await this.handleDue(parsed[1]!, Number(parsed[2]), Number(parsed[3]));
  }

  /** The scheduler skipped a job (slept through it): the same deadline rules decide. */
  missed(job: Pick<CronJob, "creationKey">): Promise<void> {
    return KEY_PATTERN.test(job.creationKey ?? "") ? this.wake(job) : Promise.resolve();
  }

  private timing(rule: ScheduleNoticeRule) {
    const runAt = dueAt(rule.wake);
    return {
      runAt,
      timezone: rule.when.timezone,
      missedPolicy: rule.when.missedPolicy,
      ...(rule.when.missedPolicy === "fire-once"
        ? { catchUpUntil: Math.max(runAt, occurrenceDeadline(rule.when, rule.wake.occurrence)) }
        : {}),
    };
  }

  private matches(job: CronJob, rule: ScheduleNoticeRule): boolean {
    const timing = this.timing(rule);
    return (
      job.enabled &&
      job.name === rule.then.title.slice(0, JOB_NAME_MAX) &&
      job.prompt === JOB_PROMPT &&
      job.schedule === "once" &&
      job.once === true &&
      job.runAt === timing.runAt &&
      job.timezone === timing.timezone &&
      job.missedPolicy === timing.missedPolicy &&
      job.catchUpUntil === timing.catchUpUntil &&
      job.resumeSessionId === undefined
    );
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((error) => this.deps.onError?.(error));
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  /** Claim, then fire or record the miss. A stale or duplicate trigger claims nothing. */
  private async handleDue(id: string, version: number, occurrence: number): Promise<void> {
    const rule = await this.deps.rules.claimOccurrence(id, version, occurrence);
    if (!rule) return;
    const now = this.now();
    const due = dueAt(rule.wake);
    const deadline = Math.max(due, occurrenceDeadline(rule.when, occurrence));
    const skipped = rule.when.missedPolicy === "skip" && now - due > MISFIRE_GRACE_MS;
    if (now > deadline || skipped) {
      const repeating = rule.when.cron !== undefined;
      await this.deps.rules.settleOccurrence(
        id,
        occurrence,
        { status: "failed", detail: repeating ? MISSED_REPEAT : MISSED_ONCE },
        // The latest occurrence still inside its own window gets the one catch-up.
        repeating && rule.when.missedPolicy === "fire-once"
          ? { nextAfter: now - (occurrenceDeadline(rule.when, occurrence) - occurrence) }
          : {},
      );
      return;
    }
    const key = ruleScheduleKey(id, version, occurrence);
    let outcome: RuleWakeOutcome;
    try {
      outcome = await this.deps.fire(rule, { occurrence, deadline, key });
    } catch (error) {
      // An exception after launch/send cannot prove that the effect did not occur.
      outcome = {
        status: "unknown",
        detail: `处理结果待核实，未自动重试：${String(error)}`.slice(0, WAKE_DETAIL_MAX),
      };
      this.deps.onError?.(error);
    }
    await this.deps.rules.settleOccurrence(id, occurrence, outcome);
  }

  /** Owner decision: old follow-up data is dropped, not migrated. Best effort, once. */
  private async retireLegacy(): Promise<void> {
    if (this.legacyRetired) return;
    this.legacyRetired = true;
    let jobs = 0;
    let file = false;
    try {
      const scheduler = this.deps.scheduler();
      for (const job of scheduler.list()) {
        if (isLegacyJob(job) && scheduler.delete(job.id)) jobs += 1;
      }
      const path = this.deps.legacyFollowUpsPath;
      if (path) {
        const exists = await stat(path).then(
          () => true,
          () => false,
        );
        if (exists) {
          await rm(path, { force: true });
          file = true;
        }
      }
    } catch (error) {
      this.deps.log?.("pet.followUp.legacy_drop_failed", { error: String(error) });
    }
    if (jobs > 0 || file) this.deps.log?.("pet.followUp.legacy_dropped", { jobs, file });
  }
}
