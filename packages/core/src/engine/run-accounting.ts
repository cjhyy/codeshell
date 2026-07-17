/**
 * Run accounting — cumulative usage counters, the external-billed-usage
 * funnel (aux summaries, goal judge, title), the goal-budget guard on the
 * primary model call, and the ModelFacade wiring for a run.
 */
import type { TokenUsage } from "../types.js";
import {
  addTokenUsage,
  addCumulativeUsage,
  normalizeCumulativeUsageCounters,
  type CumulativeUsageCounters,
} from "../session/usage.js";
import { logger } from "../logging/logger.js";
import type { LLMClientBase } from "../llm/client-base.js";
import type { Transcript } from "../session/transcript.js";
import type { SessionBundle, SessionStateFieldPatch } from "../session/session-manager.js";
import { ModelFacade } from "./model-facade.js";
import type { TurnLoop } from "./turn-loop.js";
import type { EngineConfig } from "./types.js";

export interface RunUsageAccounting {
  recordCumulativeUsage: (usage: TokenUsage) => CumulativeUsageCounters;
  recordExternalBilledUsage: (usage: TokenUsage) => CumulativeUsageCounters;
  getExternalRunUsage: () => TokenUsage;
  /** goal 预算耗尽后主模型调用需要短路(见 wireRunModelFacade)。 */
  hasGoalBudgetTermination: () => boolean;
  markRunAccountingFinalized: () => void;
}

/** engine.ts L1779-1821:externalRunUsage/runAccountingFinalized/两个 record 闭包。 */
export function createRunUsageAccounting(args: {
  session: SessionBundle;
  sid: string;
  resumeState: (sid: string) => SessionBundle["state"]; // this.sessionManager.resume(sid).state
  updatePersistedSessionState: (sid: string, patch: SessionStateFieldPatch) => void;
  costStore: EngineConfig["costStore"];
  /** engine 侧闭包 (usage) => turnLoop.recordGoalJudgeUsage(usage)(turnLoop 延迟赋值)。 */
  recordGoalJudgeUsage: (
    usage: TokenUsage,
  ) => ReturnType<TurnLoop["recordGoalJudgeUsage"]>;
}): RunUsageAccounting {
  const { session, sid, resumeState, updatePersistedSessionState, costStore, recordGoalJudgeUsage } =
    args;
  let autoCompactionGoalTermination: ReturnType<TurnLoop["recordGoalJudgeUsage"]>;
  let externalRunUsage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let runAccountingFinalized = false;
  Object.assign(
    session.state,
    normalizeCumulativeUsageCounters(session.state, session.state.tokenUsage),
  );
  const recordCumulativeUsage = (usage: TokenUsage): CumulativeUsageCounters => {
    const next = addCumulativeUsage(session.state, usage);
    Object.assign(session.state, next);
    return next;
  };
  const recordExternalBilledUsage = (usage: TokenUsage): CumulativeUsageCounters => {
    externalRunUsage = addTokenUsage(externalRunUsage, usage);
    const cumulative = recordCumulativeUsage(usage);
    autoCompactionGoalTermination = recordGoalJudgeUsage(usage);
    if (runAccountingFinalized) {
      try {
        const latest = resumeState(sid);
        const lateCumulative = addCumulativeUsage(latest, usage);
        updatePersistedSessionState(sid, {
          tokenUsage: addTokenUsage(latest.tokenUsage, usage),
          ...lateCumulative,
          ...(costStore
            ? {
                costState: costStore.serialize() as Record<string, unknown>,
              }
            : {}),
        });
      } catch (err) {
        logger.warn("engine.late_usage_persist_failed", {
          sessionId: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return cumulative;
  };

  return {
    recordCumulativeUsage,
    recordExternalBilledUsage,
    getExternalRunUsage: () => externalRunUsage,
    hasGoalBudgetTermination: () => Boolean(autoCompactionGoalTermination),
    markRunAccountingFinalized: () => {
      runAccountingFinalized = true;
    },
  };
}

/** engine.ts L1825-1894:ModelFacade + 预算护栏 call 包装 + getRunUsage + aux summarize。 */
export function wireRunModelFacade(args: {
  llmClient: LLMClientBase;
  auxSummaryClient: LLMClientBase;
  transcript: Transcript;
  accounting: RunUsageAccounting;
}): {
  modelFacade: ModelFacade;
  getRunUsage: () => ReturnType<ModelFacade["getUsage"]>;
} {
  const { llmClient, auxSummaryClient, transcript, accounting } = args;

  // Create components (requires resolved llmClient).
  const modelFacade = new ModelFacade(llmClient, transcript);
  const getRunUsage = () => {
    const visible = modelFacade.getUsage();
    const externalRunUsage = accounting.getExternalRunUsage();
    return {
      ...visible,
      totalPromptTokens: visible.totalPromptTokens + externalRunUsage.promptTokens,
      totalCompletionTokens: visible.totalCompletionTokens + externalRunUsage.completionTokens,
      totalTokens: visible.totalTokens + externalRunUsage.totalTokens,
      totalCacheReadTokens:
        visible.totalCacheReadTokens + (externalRunUsage.cacheReadTokens ?? 0),
      totalCacheCreationTokens:
        visible.totalCacheCreationTokens + (externalRunUsage.cacheCreationTokens ?? 0),
    };
  };
  const callPrimaryModel = modelFacade.call.bind(modelFacade);
  modelFacade.call = async (...callArgs: Parameters<ModelFacade["call"]>) => {
    // A primary-model summary may itself exhaust the Goal budget. Do not
    // issue the main turn request after that billed sub-call; return control
    // to TurnLoop, whose existing post-response guard emits and persists the
    // canonical goal_budget_exhausted termination.
    if (accounting.hasGoalBudgetTermination()) {
      return {
        text: "",
        toolCalls: [],
        stopReason: "stop",
      };
    }
    return callPrimaryModel(...callArgs);
  };

  // Wire getOutputTokens for token budget tracking
  modelFacade.getOutputTokens = () => {
    const usage = getRunUsage();
    return usage.totalCompletionTokens;
  };

  // Wire summarize for tool use summaries (uses lightweight call). Keep the
  // request out of the foreground tracker while billing and reporting it to
  // the owning session/Goal budget.
  modelFacade.summarize = async (sysPrompt: string, userMsg: string, signal?: AbortSignal) => {
    const resp = await auxSummaryClient.createMessage({
      systemPrompt: sysPrompt,
      messages: [{ role: "user", content: userMsg }],
      tools: [],
      maxTokens: 256,
      signal,
      billingEnabled: true,
      requestVisible: false,
      // Auxiliary call — see contextManager.setSummarizeFn above.
      reasoning: { mode: "off" },
    });
    if (resp.usage) accounting.recordExternalBilledUsage(resp.usage);
    logger.debug("summarize.call", {
      sysPromptLen: sysPrompt.length,
      userMsgLen: userMsg.length,
      userMsgPreview: userMsg.slice(0, 300),
      completionLen: resp.text.length,
      completionPreview: resp.text.slice(0, 300),
      stopReason: resp.stopReason,
      promptTokens: resp.usage?.promptTokens,
      completionTokens: resp.usage?.completionTokens,
    });
    return resp.text;
  };

  return { modelFacade, getRunUsage };
}
