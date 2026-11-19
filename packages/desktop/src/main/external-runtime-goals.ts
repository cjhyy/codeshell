import { randomUUID } from "node:crypto";
import { SessionManager, type GoalConfig, type StreamEvent } from "@cjhyy/code-shell-core";
import { goalGetPayload } from "@cjhyy/code-shell-core/internal";

// These count provider turns, each of which already contains its own tool loop.
export const EXTERNAL_GOAL_DEFAULT_TURNS = 12;
export const EXTERNAL_GOAL_DEFAULT_STOP_BLOCKS = 3;
export const EXTERNAL_GOAL_DEFAULT_TIME_MS = 30 * 60_000;
export const EXTERNAL_GOAL_TOOLS = [
  "get_goal",
  "complete_goal",
  "cancel_goal",
  "wait_for_user",
  "wait_for_background",
] as const;
/** A question is one or two sentences; background belongs in the reply text. */
export const EXTERNAL_GOAL_MAX_QUESTION_CHARS = 600;
export const EXTERNAL_GOAL_MAX_OPTIONS = 6;
export const EXTERNAL_GOAL_MAX_OPTION_CHARS = 80;
const MAX_CLOSED_QUESTIONS = 8;

/** L1 "preference": has a sensible default. L2 "consent": needs explicit agreement. */
export type ExternalGoalQuestionLevel = "preference" | "consent";

/** A wait_for_user question as the host shows it (never repeated in reply text). */
export interface ExternalGoalQuestion {
  text: string;
  level: ExternalGoalQuestionLevel;
  options?: string[];
  default?: string;
}

/** Whether a provider-reported tool name is one of the Goal controller tools. */
export function isExternalGoalToolName(toolName: string): boolean {
  const bare = toolName.slice(toolName.lastIndexOf("__") + 1).replace(/^_/u, "");
  return (EXTERNAL_GOAL_TOOLS as readonly string[]).includes(bare);
}

const sameQuestion = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();

/** Validate wait_for_user arguments; a bare `question` stays valid. */
export function parseExternalGoalQuestion(
  args: Record<string, unknown>,
): { question: ExternalGoalQuestion } | { error: string } {
  const text = typeof args.question === "string" ? args.question.trim() : "";
  if (!text) return { error: "wait_for_user needs the question you are asking the user." };
  if (text.length > EXTERNAL_GOAL_MAX_QUESTION_CHARS) {
    return {
      error: `The question must be at most ${EXTERNAL_GOAL_MAX_QUESTION_CHARS} characters: ask one short question and put background in your reply.`,
    };
  }
  if (args.level !== undefined && args.level !== "preference" && args.level !== "consent") {
    return { error: 'level must be "preference" or "consent".' };
  }
  const level: ExternalGoalQuestionLevel = args.level === "consent" ? "consent" : "preference";
  let options: string[] | undefined;
  if (args.options !== undefined) {
    if (
      !Array.isArray(args.options) ||
      args.options.length > EXTERNAL_GOAL_MAX_OPTIONS ||
      args.options.some(
        (option) =>
          typeof option !== "string" ||
          !option.trim() ||
          option.trim().length > EXTERNAL_GOAL_MAX_OPTION_CHARS,
      )
    ) {
      return {
        error: `options must be at most ${EXTERNAL_GOAL_MAX_OPTIONS} short labels (${EXTERNAL_GOAL_MAX_OPTION_CHARS} characters each).`,
      };
    }
    options = [...new Set((args.options as string[]).map((option) => option.trim()))];
  }
  if (
    args.default !== undefined &&
    (typeof args.default !== "string" ||
      !args.default.trim() ||
      args.default.trim().length > EXTERNAL_GOAL_MAX_QUESTION_CHARS)
  ) {
    return { error: "default must be one of the options or a short text." };
  }
  const fallback = typeof args.default === "string" ? args.default.trim() : undefined;
  return {
    question: {
      text,
      level,
      // A consent question is answered 同意 / 不同意; the host supplies those.
      ...(options?.length && level !== "consent" ? { options } : {}),
      // Consent never has a default: silence or an ambiguous reply is not agreement.
      ...(fallback && level !== "consent" ? { default: fallback } : {}),
    },
  };
}

export interface ExternalGoalUpdate {
  objective?: string;
  paused?: boolean;
  expectedGoalId: string;
  expectedRevision: number;
}

export interface ExternalGoalExtension {
  addTurns?: number;
  addTokenBudget?: number;
  addTimeBudgetMs?: number;
  addStopBlocks?: number;
}

export interface ExternalGoalRun {
  sessionId: string;
  goal: GoalConfig;
  startedAtMs: number;
  turns: number;
  tokensUsed: number;
  maxTurns: number;
  maxStopBlocks: number;
  tokenBudget?: number;
  timeBudgetMs: number;
  stopBlocks: number;
  lastOutput?: string;
  stopped: boolean;
  /** End after the current provider turn without pausing (the user has input queued). */
  yieldRequested?: boolean;
  /** The model called wait_for_user this turn; end the run and wait for a reply. */
  awaitingUser?: boolean;
  /** The model called wait_for_background this turn; park when the turn ends. */
  awaitingBackground?: boolean;
  /** The last continuation told the model background work is still running. */
  backgroundReminded?: boolean;
  /** Top-level work tool calls in the current provider turn. */
  turnToolCalls: number;
  /** complete_goal / cancel_goal ended the run (core's `goal_control_stop`). */
  settled?: "completed" | "cancelled";
  /** A budget or limit paused the Goal and ended the run (core's `limit_stop`). */
  limited?: true;
  /** Goal-level rounds/active time persisted before this run started. */
  progressBase: { rounds: number; activeMs: number };
  /** Frozen at pause/park/completion, even if the provider takes time to finish. */
  clockStoppedAtMs?: number;
}

/** Display-only description of finite work a parked Goal waits on. */
export interface ExternalGoalWaitingTask {
  kind: string;
  label: string;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameVersion(left: GoalConfig | undefined, right: GoalConfig): boolean {
  return !!left && left.goalId === right.goalId && left.revision === right.revision;
}

function goalInput(raw: string | GoalConfig): GoalConfig {
  const value = typeof raw === "string" ? { objective: raw } : raw;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.objective !== "string" ||
    !value.objective.trim() ||
    value.objective.length > 64 * 1024
  ) {
    throw new Error("A non-empty, bounded goal objective is required");
  }
  const goal: GoalConfig = { objective: value.objective.trim() };
  for (const key of ["tokenBudget", "timeBudgetMs", "maxTurns", "maxStopBlocks"] as const) {
    if (value[key] !== undefined) {
      if (!positiveInteger(value[key])) throw new Error(`Invalid goal ${key}`);
      goal[key] = value[key];
    }
  }
  return goal;
}

/** Canonical persistence and version fences; no provider-specific state files. */
export class ExternalRuntimeGoals {
  private readonly manager = new SessionManager();
  private readonly runs = new Map<string, ExternalGoalRun>();
  /** Questions the model is waiting on, per Session, until the user replies. */
  private readonly pendingQuestions = new Map<string, ExternalGoalQuestion>();
  /** Questions the user already replied to or passed over; never asked again. */
  private readonly closedQuestions = new Map<string, string[]>();

  constructor(
    private readonly emit: (sessionId: string, event: StreamEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  read(sessionId: string): GoalConfig | undefined {
    return this.manager.readActiveGoal(sessionId);
  }

  get(sessionId: string) {
    const goal = this.read(sessionId);
    return goalGetPayload(goal, goal ? this.manager.readGoalProgress(sessionId) : undefined);
  }

  running(sessionId: string): ExternalGoalRun | undefined {
    return this.runs.get(sessionId);
  }

  start(sessionId: string, explicit?: string | GoalConfig, disabled = false) {
    if (disabled) return undefined;
    const stored = this.read(sessionId);
    let goal = stored;
    if (explicit !== undefined) {
      goal = goalInput(explicit);
      goal.goalId = randomUUID();
      goal.revision = 1;
      goal.setAtMs =
        stored?.objective === goal.objective ? (stored.setAtMs ?? this.now()) : this.now();
      const state = this.manager.readSessionState(sessionId);
      if (!state || !this.manager.saveActiveGoal(state, goal, { replaceCurrent: !!stored })) {
        throw new Error("Could not persist the external runtime goal");
      }
      this.emit(sessionId, {
        type: "goal_set",
        goalId: goal.goalId,
        revision: goal.revision,
        objective: goal.objective,
        replaced: !!stored,
        setAtMs: goal.setAtMs,
      });
    }
    if (!goal || goal.paused) return undefined;
    if (explicit === undefined) {
      const state = this.manager.readSessionState(sessionId);
      if (
        !state ||
        !this.manager.saveActiveGoal(state, goal, {
          expectedGoalId: goal.goalId,
          expectedRevision: goal.revision,
        })
      ) {
        throw new Error("Could not re-arm the external runtime goal");
      }
    }
    // Read after re-arming: a finished background wait is settled by then.
    const persisted = this.manager.readGoalProgress(sessionId);
    const run: ExternalGoalRun = {
      sessionId,
      goal: { ...goal },
      progressBase:
        persisted && persisted.goalId === goal.goalId
          ? { rounds: persisted.rounds, activeMs: persisted.activeMs }
          : { rounds: 0, activeMs: 0 },
      startedAtMs: this.now(),
      turns: 0,
      tokensUsed: 0,
      maxTurns: goal.maxTurns ?? EXTERNAL_GOAL_DEFAULT_TURNS,
      maxStopBlocks: goal.maxStopBlocks ?? EXTERNAL_GOAL_DEFAULT_STOP_BLOCKS,
      tokenBudget: goal.tokenBudget,
      timeBudgetMs: goal.timeBudgetMs ?? EXTERNAL_GOAL_DEFAULT_TIME_MS,
      stopBlocks: 0,
      turnToolCalls: 0,
      stopped: false,
    };
    this.runs.set(sessionId, run);
    return run;
  }

  isCurrent(run: ExternalGoalRun): boolean {
    const current = this.read(run.sessionId);
    return (
      this.runs.get(run.sessionId) === run &&
      !run.stopped &&
      !current?.paused &&
      sameVersion(current, run.goal)
    );
  }

  stop(sessionId: string): void {
    const run = this.runs.get(sessionId);
    if (run) {
      run.stopped = true;
      run.clockStoppedAtMs ??= this.now();
    }
  }

  /**
   * Let a queued user message in at the next provider-turn boundary. External
   * runtimes cannot splice input into a running turn, and every continuation
   * round lives inside one submission, so without this a typed message waited
   * for the whole Goal run. The Goal stays active; the user's message starts
   * the next run of it.
   */
  yieldAfterTurn(sessionId: string): boolean {
    const run = this.runs.get(sessionId);
    if (!run || !this.isCurrent(run)) return false;
    run.yieldRequested = true;
    return true;
  }

  /**
   * The model needs the user's answer before it can continue (an approval,
   * a choice, missing information). The run ends after this provider turn
   * without pausing the Goal; automatic continuations do not drive it until
   * the user replies, and every later instruction repeats the open question.
   */
  waitForUser(sessionId: string, args: Record<string, unknown>) {
    const run = this.runs.get(sessionId);
    if (
      !run ||
      !this.isCurrent(run) ||
      args.goalId !== run.goal.goalId ||
      args.revision !== run.goal.revision
    ) {
      return {
        ok: false,
        message: "Goal changed or is not running; read get_goal before retrying.",
      };
    }
    if (run.awaitingUser) {
      return {
        ok: false,
        message:
          "You already asked the user a question in this turn; only one is allowed. End your turn now and wait for the reply.",
      };
    }
    const parsed = parseExternalGoalQuestion(args);
    if ("error" in parsed) return { ok: false, message: parsed.error };
    const pending = this.pendingQuestions.get(sessionId);
    if (this.closedQuestions.get(sessionId)?.includes(sameQuestion(parsed.question.text))) {
      return {
        ok: false,
        message:
          "The user already replied to or passed over this question. Do not ask it again: act on their reply, or keep the default you stated and mention it in your summary.",
      };
    }
    // An unanswered question stays the one on screen; a new one never replaces it.
    const question = pending ?? parsed.question;
    const replaced = pending && sameQuestion(pending.text) !== sameQuestion(parsed.question.text);
    const state = this.manager.readSessionState(sessionId);
    if (!state || !this.manager.markGoalWaiting(state, run.goal, "user")) {
      return {
        ok: false,
        message: "Could not persist the goal's user wait; retry before ending the turn.",
      };
    }
    run.awaitingUser = true;
    run.clockStoppedAtMs ??= this.now();
    this.pendingQuestions.set(sessionId, question);
    this.emit(sessionId, {
      type: "goal_progress",
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      status: "not_met",
      ...this.progress(run, run.turns + 1),
      // The question itself travels in `waitingForUser`; never duplicate it here.
      gaps: "等待你的回复",
      waitingForUser: question.text,
      waitingForUserDetail: {
        level: question.level,
        ...(question.options ? { options: question.options } : {}),
        ...(question.default ? { default: question.default } : {}),
      },
    });
    if (replaced) {
      return {
        ok: false,
        message: `Your earlier question is still waiting for the user's reply, so the new one was not shown: ${pending.text} The goal keeps waiting on it. End your turn now.`,
      };
    }
    return {
      ok: true,
      message:
        "CodeShell shows the question to the user and the goal waits for their reply. End your turn now; do not repeat the question in your reply text.",
    };
  }

  /**
   * The model declares it has nothing left to do until background work
   * finishes. Only then does the Goal park at the end of this turn; without
   * the call, a turn that ends beside running work simply continues.
   */
  waitForBackground(sessionId: string, args: Record<string, unknown>, backgroundRunning: boolean) {
    const run = this.runs.get(sessionId);
    if (
      !run ||
      !this.isCurrent(run) ||
      args.goalId !== run.goal.goalId ||
      args.revision !== run.goal.revision
    ) {
      return {
        ok: false,
        message: "Goal changed or is not running; read get_goal before retrying.",
      };
    }
    if (!backgroundRunning) {
      return {
        ok: false,
        message:
          "No background task is still running (a finished result may already be queued for you). Continue working instead of waiting.",
      };
    }
    run.awaitingBackground = true;
    return {
      ok: true,
      message:
        "The goal parks when this turn ends and resumes when a background task completes. End your turn now; do not poll.",
    };
  }

  /**
   * What a finished provider turn does about background work that is still
   * running. `park`: the model asked to wait, or it was already told the work
   * is running and then did nothing (no tool call), so the host parks for it
   * instead of re-prompting an idle model. `remind`: continue, naming the
   * running work in the next prompt.
   */
  backgroundTurnEnd(
    run: ExternalGoalRun | undefined,
    running: boolean,
  ): "park" | "remind" | "none" {
    if (!run) return "none";
    const requested = run.awaitingBackground === true;
    const idleAfterReminder = run.backgroundReminded === true && run.turnToolCalls === 0;
    run.awaitingBackground = false;
    run.backgroundReminded = false;
    run.turnToolCalls = 0;
    if (!running) return "none";
    if (requested || idleAfterReminder) return "park";
    run.backgroundReminded = true;
    return "remind";
  }

  /** Count the turn's own work: top-level tool calls other than Goal controls. */
  observeTurnEvent(run: ExternalGoalRun, event: StreamEvent): void {
    if (
      event.type === "tool_use_start" &&
      !("agentId" in event && event.agentId !== undefined) &&
      !isExternalGoalToolName(event.toolCall.toolName)
    )
      run.turnToolCalls++;
  }

  /** The automatic continuation prompt, naming still-running background work. */
  continuation(run: ExternalGoalRun, running?: ExternalGoalWaitingTask[]): string {
    const lines = ["继续处理尚未完成的目标。"];
    // Only the turn that was found beside running work carries the reminder.
    if (run.backgroundReminded) {
      const names = (running ?? []).map((task) => `"${task.label}"`).join(", ");
      lines.push(
        [
          "<background_work>",
          `Background work is still running${names ? `: ${names}` : ""}. CodeShell notifies you when it completes; do not poll, sleep or re-check it.`,
          "If there is work that does not depend on it, continue that work now. If nothing is left to do until it finishes, call mcp__codeshell_tools__wait_for_background with this goalId and revision and end your turn.",
          "</background_work>",
        ].join("\n"),
      );
    }
    lines.push(this.instruction(run));
    return lines.join("\n\n");
  }

  pendingQuestion(sessionId: string): string | undefined {
    return this.pendingQuestions.get(sessionId)?.text;
  }

  /** Automatic work must respect a user wait after the in-memory question is gone. */
  isWaitingForUser(sessionId: string): boolean {
    if (this.pendingQuestions.has(sessionId)) return true;
    const lifecycle = this.manager.readSessionState(sessionId)?.goalLifecycle;
    return lifecycle?.phase === "waiting" && lifecycle.waitKind === "user";
  }

  /** A real user message (not an automatic continuation) answers the open question. */
  userReplied(sessionId: string): void {
    const answered = this.pendingQuestions.get(sessionId);
    if (!answered) return;
    this.pendingQuestions.delete(sessionId);
    // Whatever the user wrote, they saw this question: it is not asked twice.
    this.closedQuestions.set(
      sessionId,
      [...(this.closedQuestions.get(sessionId) ?? []), sameQuestion(answered.text)].slice(
        -MAX_CLOSED_QUESTIONS,
      ),
    );
  }

  private forgetQuestions(sessionId: string): void {
    this.pendingQuestions.delete(sessionId);
    this.closedQuestions.delete(sessionId);
  }

  end(run: ExternalGoalRun): void {
    if (this.runs.get(run.sessionId) === run) this.runs.delete(run.sessionId);
    // Accounting for this run belongs to the goal identity even if it was
    // edited, paused or completed meanwhile; a replaced goal drops it.
    const state = this.manager.readSessionState(run.sessionId);
    if (state && run.goal.goalId) {
      this.manager.recordGoalProgress(state, run.goal.goalId, {
        rounds: run.turns,
        activeMs: this.elapsed(run),
      });
    }
  }

  update(sessionId: string, patch: ExternalGoalUpdate) {
    if (!patch.expectedGoalId || !positiveInteger(patch.expectedRevision)) {
      throw new Error("Goal controls require the current goalId and revision");
    }
    if (patch.objective !== undefined) goalInput(patch.objective);
    if (patch.paused !== undefined && typeof patch.paused !== "boolean") {
      throw new Error("Invalid goal pause state");
    }
    if (patch.objective === undefined && patch.paused === undefined) {
      throw new Error("A goal update is required");
    }
    const updated = this.manager.updateActiveGoal(sessionId, patch);
    if (!updated) return { ...this.get(sessionId), updated: false };
    this.stop(sessionId);
    this.emitUpdated(sessionId, updated.goal);
    return { ...this.get(sessionId), updated: true };
  }

  delete(sessionId: string, expected?: { expectedGoalId?: string; expectedRevision?: number }) {
    if (
      expected &&
      (expected.expectedGoalId !== undefined || expected.expectedRevision !== undefined) &&
      (!expected.expectedGoalId || !positiveInteger(expected.expectedRevision))
    ) {
      throw new Error("Goal deletion requires the current goalId and revision");
    }
    const goal = this.read(sessionId);
    const cleared = this.manager.clearActiveGoal(sessionId, {
      goalId: expected?.expectedGoalId ?? goal?.goalId,
      revision: expected?.expectedRevision ?? goal?.revision,
    });
    if (cleared) {
      this.stop(sessionId);
      this.forgetQuestions(sessionId);
      this.emit(sessionId, {
        type: "goal_cleared",
        goalId: goal?.goalId,
        revision: goal?.revision,
      });
    }
    return { ok: true as const, cleared };
  }

  extend(sessionId: string, extension: ExternalGoalExtension) {
    const keys = ["addTurns", "addTokenBudget", "addTimeBudgetMs", "addStopBlocks"] as const;
    if (!keys.some((key) => extension[key] !== undefined)) {
      throw new Error("At least one goal extension is required");
    }
    for (const key of keys) {
      if (extension[key] !== undefined && !positiveInteger(extension[key])) {
        throw new Error(`Invalid goal extension ${key}`);
      }
    }
    const run = this.runs.get(sessionId);
    if (!run || !this.isCurrent(run)) throw new Error("No active external goal run to extend");
    const add = (current: number, delta = 0) => Math.min(Number.MAX_SAFE_INTEGER, current + delta);
    run.maxTurns = add(run.maxTurns, extension.addTurns);
    run.maxStopBlocks = add(run.maxStopBlocks, extension.addStopBlocks);
    if (extension.addTokenBudget) {
      run.tokenBudget = add(run.tokenBudget ?? run.tokensUsed, extension.addTokenBudget);
    }
    run.timeBudgetMs = add(run.timeBudgetMs, extension.addTimeBudgetMs);
    return {
      ok: true as const,
      limits: {
        maxTurns: run.maxTurns,
        maxStopBlocks: run.maxStopBlocks,
        ...(run.tokenBudget !== undefined ? { tokenBudget: run.tokenBudget } : {}),
        timeBudgetMs: run.timeBudgetMs,
      },
    };
  }

  remainingTime(run: ExternalGoalRun): number {
    return Math.max(0, run.timeBudgetMs - (this.now() - run.startedAtMs));
  }

  /** Park only the matching live Goal; completion delivery will re-arm it. */
  waitForBackgroundWork(run: ExternalGoalRun, tasks: ExternalGoalWaitingTask[] = []): boolean {
    if (!this.isCurrent(run)) return false;
    const state = this.manager.readSessionState(run.sessionId);
    if (!state || !this.manager.markGoalWaiting(state, run.goal, "background")) return false;
    // The persisted lifecycle owns time from waitingSinceMs onward. Avoid
    // charging the same interval again if the run's cleanup is delayed.
    run.clockStoppedAtMs ??= Math.min(
      this.now(),
      state.goalLifecycle?.phase === "waiting" ? state.goalLifecycle.waitingSinceMs : this.now(),
    );
    this.emit(run.sessionId, {
      type: "goal_progress",
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      status: "not_met",
      ...this.progress(run, run.turns),
      waiting: {
        kind: "background_work",
        sinceMs: this.now(),
        ...(tasks.length > 0 ? { tasks } : {}),
      },
    });
    return true;
  }

  afterTurn(
    run: ExternalGoalRun,
    tokens: number,
    output: string,
    waitingForBackgroundWork = false,
  ): boolean {
    run.turns++;
    if (Number.isFinite(tokens) && tokens > 0) run.tokensUsed += tokens;
    run.stopBlocks = run.lastOutput === output ? run.stopBlocks + 1 : 0;
    run.lastOutput = output;
    if (!this.isCurrent(run) || run.yieldRequested || run.awaitingUser) return false;
    const limit =
      run.tokenBudget !== undefined && run.tokensUsed >= run.tokenBudget
        ? "达到本轮 token 预算"
        : this.remainingTime(run) === 0
          ? "达到本轮时间预算"
          : run.turns >= run.maxTurns
            ? "达到本轮自动继续次数上限"
            : run.stopBlocks >= run.maxStopBlocks
              ? "连续多轮没有新的进展"
              : undefined;
    if (limit) {
      this.pause(run, limit);
      return false;
    }
    if (waitingForBackgroundWork) return true;
    const remaining = run.maxTurns - run.turns;
    this.emit(run.sessionId, {
      type: "goal_progress",
      goalId: run.goal.goalId,
      revision: run.goal.revision,
      status: remaining <= 2 ? "approaching_limit" : "not_met",
      ...this.progress(run, run.turns),
      gaps: "外部运行器尚未声明目标完成，继续处理。",
      ...(remaining <= 2 ? { turnsRemaining: remaining, nearest: "turns" as const } : {}),
    });
    return true;
  }

  /**
   * Pause the Goal. A budget or limit pause ends the run as `limit_stop`
   * (Mimi notices read it as blocked on a limit); a pause the user asked for
   * (`byUser`, a Stop) does not.
   */
  pause(run: ExternalGoalRun, reason: string, byUser = false): void {
    if (!this.isCurrent(run)) return;
    const result = this.update(run.sessionId, {
      paused: true,
      expectedGoalId: run.goal.goalId!,
      expectedRevision: run.goal.revision!,
    });
    if (result.updated) {
      if (!byUser) run.limited = true;
      this.emit(run.sessionId, {
        type: "goal_progress",
        goalId: result.goalId,
        revision: result.revision,
        status: "not_met",
        ...this.progress(run, run.turns),
        gaps: `${reason}；目标已暂停，可继续。`,
      });
    }
  }

  settle(sessionId: string, status: "completed" | "cancelled", args: Record<string, unknown>) {
    const run = this.runs.get(sessionId);
    if (
      !run ||
      !this.isCurrent(run) ||
      args.goalId !== run.goal.goalId ||
      args.revision !== run.goal.revision
    ) {
      return {
        ok: false,
        message: "Goal changed or is not running; read get_goal before retrying.",
      };
    }
    if (
      status === "cancelled" &&
      (args.confirm !== true || typeof args.reason !== "string" || !args.reason.trim())
    ) {
      return { ok: false, message: "Cancellation requires confirm=true and the user's reason." };
    }
    const state = this.manager.readSessionState(sessionId);
    if (!state || this.manager.saveGoalTerminalOutcome(state, run.goal, status) !== "persisted") {
      return { ok: false, message: "Goal changed or could not be saved; no completion recorded." };
    }
    run.stopped = true;
    run.settled = status;
    run.clockStoppedAtMs ??= this.now();
    this.forgetQuestions(sessionId);
    if (status === "completed") {
      this.emit(sessionId, {
        type: "goal_progress",
        goalId: run.goal.goalId,
        revision: run.goal.revision,
        status: "met",
        ...this.progress(run, run.turns + 1),
        ...(typeof args.summary === "string" ? { gaps: args.summary } : {}),
      });
    } else {
      this.emit(sessionId, {
        type: "goal_cleared",
        goalId: run.goal.goalId,
        revision: run.goal.revision,
      });
    }
    return { ok: true, status };
  }

  instruction(run: ExternalGoalRun): string {
    return [
      "<codeshell_goal>",
      `Goal: ${run.goal.objective}`,
      `goalId: ${run.goal.goalId}; revision: ${run.goal.revision}; setAtMs: ${run.goal.setAtMs}.`,
      "Continue useful work toward this persisted goal. A normal final reply does not complete it.",
      "Only when the objective is fully achieved, call mcp__codeshell_tools__complete_goal with this goalId and revision and a completion summary.",
      "Only if the user explicitly cancels it, call mcp__codeshell_tools__cancel_goal with this goalId, revision, confirm=true and the user's reason.",
      "Use mcp__codeshell_tools__get_goal to check the current identity. Do not call the runtime's separate create_goal/update_goal tools for this CodeShell goal.",
      `This run allows ${run.maxTurns} provider turns and ${run.timeBudgetMs} ms${run.tokenBudget ? `, with ${run.tokenBudget} tokens` : ""}. If it pauses, do not claim completion.`,
      "CodeShell sends automatic continuation messages (such as 继续处理尚未完成的目标 or 继续执行已保存的目标) to keep this goal moving. Such a message is not a reply from the user: it never answers a question you asked and never grants an approval you requested.",
      'Decisions come in three levels. L0, a reversible engineering or quality decision (how to split a change, which step first, naming): decide it yourself and do not ask. L1, a preference with a sensible default (for example which kind of release was meant): state the default you are taking, proceed with it, and list it in your final summary so the user can change it. L2, anything irreversible or outward-facing: writes to production or live systems, publishing or sending to other people, deleting data that cannot be restored, creating or installing credentials or keys, granting new permissions, spending money. For L2 you must ask with level "consent" and act only after the user explicitly agrees; a reply that is ambiguous, off-topic or merely asks you to look into it is not consent, so do the other safe work and leave that step undone.',
      'To ask, call mcp__codeshell_tools__wait_for_user with this goalId and revision, one short question, level ("preference" or "consent"), and when they help short options and the default you would take. CodeShell shows the question to the user and the goal stops until they reply: do not repeat the question in your reply text, and end your turn after the call. Only one wait_for_user call is accepted per turn, so put every open decision into that one question.',
      "Ask sparingly. Never ask again a question the user has already answered, skipped or left unanswered: act on their answer, or keep the default you stated and mention it in your summary.",
      "When background work you started is still running, CodeShell tells you when it completes; do not poll or sleep. Keep doing work that does not depend on it. Only when nothing is left to do until it finishes, call mcp__codeshell_tools__wait_for_background with this goalId and revision and end your turn; the goal then parks and resumes on completion.",
      "Never present the current state of a live, remote or production system (what is deployed, what a server or database contains, what is published) as fact unless you checked it in this session. Otherwise label the claim explicitly as inferred from documentation and unverified, and verify before planning irreversible steps on it.",
      "When the objective is a matter of judgment (looks good enough, no obvious differences, acceptable quality), the user's verdict decides it. If the user says the current result is acceptable or good enough (for example 可以接受, 还好, 行, 就这样), take that as acceptance of the result as a whole, not only of the part you showed, unless they explicitly limit it. Then finish wrap-up work such as committing and recording known limitations, and call mcp__codeshell_tools__complete_goal; do not ask the user to accept the remaining items one by one.",
      ...(this.pendingQuestions.has(run.sessionId)
        ? [
            `The user has not yet answered your question: ${this.pendingQuestions.get(run.sessionId)!.text} It is still shown to them. Do not proceed with anything that depends on that answer; if nothing else is left to do, call wait_for_user with the same question to keep waiting.`,
          ]
        : []),
      "</codeshell_goal>",
    ].join("\n");
  }

  /**
   * Goal-level round and time for a marker. `turnsCounted` is the provider
   * turns of this run that the marker covers (the in-flight turn included when
   * it is emitted from inside that turn).
   */
  private progress(run: ExternalGoalRun, turnsCounted: number) {
    const atMs = this.now();
    const rounds = run.progressBase.rounds + turnsCounted;
    return {
      round: rounds,
      progress: {
        rounds,
        activeMs: run.progressBase.activeMs + this.elapsed(run, atMs),
        atMs,
      },
    };
  }

  private elapsed(run: ExternalGoalRun, atMs = this.now()): number {
    return Math.max(0, (run.clockStoppedAtMs ?? atMs) - run.startedAtMs);
  }

  private emitUpdated(sessionId: string, goal: GoalConfig): void {
    this.emit(sessionId, {
      type: "goal_updated",
      goalId: goal.goalId,
      revision: goal.revision,
      objective: goal.objective,
      paused: goal.paused === true,
      ...(goal.setAtMs ? { setAtMs: goal.setAtMs } : {}),
    });
  }
}
