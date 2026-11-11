import { createHash } from "node:crypto";
import { SessionManager, type EngineResult } from "@cjhyy/code-shell-core";
import { PET_BEHAVIOR_PROFILE, validatePetRunParams } from "@cjhyy/code-shell-pet";
import { PET_MANAGER_TOOL_CATALOG } from "@cjhyy/code-shell-pet/capability";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import type { ExternalRuntimeToolProfile } from "../external-runtime-tool-profile.js";
import { removeExternalRuntimeBinding } from "../external-runtime-state.js";
import { buildExternalRuntimeHandoffFromEvents } from "../external-runtime-handoff.js";
import { getSessionEvents } from "../rawTranscript.js";
import { assertDesktopSessionId } from "../session-validation.js";

type Service = Pick<ExternalRuntimeService, "ensure" | "send" | "stop">;
type Response = { ok: true; result: EngineResult } | { ok: false; message: string };

/** Uses the same Pet profile, deferred requests and receipts as the native manager. */
export function createPetExternalRuntime(deps: {
  service(): Service | null;
  cwd: string;
  manager?: SessionManager;
  history?: typeof getSessionEvents;
}) {
  const manager = deps.manager ?? new SessionManager();
  const profiles = new Map<
    string,
    {
      profile: ExternalRuntimeToolProfile;
      params: Readonly<Record<string, unknown>>;
      services: Record<string, unknown>;
      result: Record<string, unknown>;
    }
  >();
  const tails = new Map<string, Promise<unknown>>();
  const generations = new Map<string, number>();

  function session(sessionId: string) {
    assertDesktopSessionId(sessionId);
    return manager.exists(sessionId)
      ? manager.resume(sessionId)
      : manager.create(deps.cwd, "", "", sessionId, null, "desktop", "pet");
  }

  async function resetContext(sessionId: string): Promise<void> {
    const service = deps.service();
    if (!service) throw new Error("外部聊天运行时尚未就绪，请稍后重试。");
    await service.stop(sessionId);
    const bundle = session(sessionId);
    // Removing a resume key must succeed: otherwise /clear could revive old context.
    removeExternalRuntimeBinding(sessionId, true);
    bundle.transcript.append("session_meta", { externalContextReset: true });
    if (bundle.transcript.flushFailed()) throw new Error("外部聊天上下文重置未能保存。");
  }

  async function runExclusive(
    params: Record<string, unknown>,
    generation: number,
  ): Promise<Response> {
    const model = typeof params.model === "string" ? params.model : undefined;
    const parsed = parseExternalRuntimeModelKey(model);
    if (!parsed || !parsed.model) throw new Error("请选择有效的外部聊天模型。");
    const invalid = validatePetRunParams(params);
    if (invalid) throw new Error(invalid);
    const sessionId = params.sessionId;
    assertDesktopSessionId(sessionId);
    if (typeof params.task !== "string" || !params.task.trim())
      throw new Error("聊天内容不能为空。");
    const assertCurrent = () => {
      if ((generations.get(sessionId) ?? 0) !== generation)
        throw new Error("外部聊天已停止，未启动新的模型请求。");
    };
    assertCurrent();
    const task = params.task.trim();
    const inputHash = createHash("sha256")
      .update(JSON.stringify([task, params.attachments ?? []]))
      .digest("hex");
    const clientMessageId =
      typeof params.clientMessageId === "string" ? params.clientMessageId : undefined;
    const bundle = session(sessionId);
    if (clientMessageId) {
      const prior = bundle.transcript.findRunResultByClientMessageId(clientMessageId);
      if (prior) {
        if (
          prior.extensions?.externalManagerInputHash &&
          prior.extensions.externalManagerInputHash !== inputHash
        )
          throw new Error("同一消息的内容发生变化，未重复执行。");
        const failure = prior.extensions?.externalRuntimeFailure;
        return typeof failure === "string"
          ? { ok: false, message: failure }
          : { ok: true, result: prior };
      }
      if (bundle.transcript.hasClientMessageId(clientMessageId))
        throw new Error(
          "这条消息的外部执行结果尚未确认，未重复执行，也未切换到 API 模型。请查看原会话。",
        );
    }
    const service = deps.service();
    if (!service) throw new Error("外部聊天运行时尚未就绪；未切换到 API 模型。");
    if (params.archiveBeforeCurrentTurn) await resetContext(sessionId);

    const toolAllowlist = Array.isArray(params.toolAllowlist)
      ? new Set(params.toolAllowlist.filter((name): name is string => typeof name === "string"))
      : undefined;
    const catalog = toolAllowlist
      ? PET_MANAGER_TOOL_CATALOG.filter((tool) => toolAllowlist.has(tool.definition.name))
      : PET_MANAGER_TOOL_CATALOG;
    const profileId = `pet-manager:${catalog.map((tool) => tool.definition.name).join(",")}`;
    let state = profiles.get(sessionId);
    if (!state || state.profile.id !== profileId) {
      state = {
        params: {},
        services: {},
        result: {},
        profile: undefined as unknown as ExternalRuntimeToolProfile,
      };
      const current = state;
      state.profile = {
        id: profileId,
        catalog,
        instructions: PET_BEHAVIOR_PROFILE.systemPromptAppend ?? "",
        context: {},
        services: () => current.services,
        visibility: () => ({
          behaviorProfile: PET_BEHAVIOR_PROFILE.id,
          profileMeta: PET_BEHAVIOR_PROFILE.buildVisibilityMeta?.(current.params),
        }),
        mimiHost: true,
        readOnly: true,
        disableMemory: true,
        sessionKind: "pet",
        maxToolCalls: PET_BEHAVIOR_PROFILE.maxTurns ?? 6,
      };
      profiles.set(sessionId, state);
    }
    state.params = (params.profileParams ?? {}) as Record<string, unknown>;
    state.result = {};
    const results = state.result;
    let reporting = true;
    state.services = PET_BEHAVIOR_PROFILE.createRunServices!({
      profileParams: state.params,
      reportResult: (key, value) => {
        if (reporting) results[key] = value;
      },
    });
    const events = await (deps.history ?? getSessionEvents)(sessionId);
    let resetIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]!.type === "session_meta" && events[i]!.data.externalContextReset === true) {
        resetIndex = i;
        break;
      }
    }
    const visibleEvents = events.slice(resetIndex + 1);
    const lastUser = [...visibleEvents]
      .reverse()
      .find(
        (event) =>
          event.type === "message" && event.data.role === "user" && event.data.injected !== true,
      );
    const lastReceipt = [...visibleEvents]
      .reverse()
      .find(
        (event) =>
          event.type === "run_result" &&
          event.data.clientMessageId === lastUser?.data.clientMessageId,
      );
    const receipt = lastReceipt?.data.result as EngineResult | undefined;
    // A native turn between external turns is present in the canonical history,
    // but absent from the provider thread. Restart with a bounded handoff.
    if (lastUser && receipt?.extensions?.externalManagerModel !== model) {
      await service.stop(sessionId);
      removeExternalRuntimeBinding(sessionId, true);
    }
    const initialContext = buildExternalRuntimeHandoffFromEvents(visibleEvents);
    await service.ensure({
      kind: parsed.kind,
      sessionId,
      cwd: deps.cwd,
      modelKey: model,
      model: parsed.model,
      permissionMode: "default",
      toolProfile: state.profile,
      assertStartAuthority: assertCurrent,
      ...(initialContext ? { initialContext } : {}),
    });
    try {
      assertCurrent();
    } catch (error) {
      await service.stop(sessionId);
      throw error;
    }
    // The changing world is input context, not durable system instructions.
    const runtimeContext =
      typeof state.params.runtimeContext === "string"
        ? state.params.runtimeContext.replace(/</g, "\\u003c")
        : "{}";
    const usageBefore = manager.readSessionState(sessionId)?.tokenUsage;
    const outcome = await service
      .send(sessionId, {
        text: `${PET_BEHAVIOR_PROFILE.runtimeContextHeading}\n<pet-world>\n${runtimeContext}\n</pet-world>\n\n${task}`,
        displayText: task,
        transcriptContent: task,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(params.injected === true ? { injected: true } : {}),
        disableGoal: true,
        modelTraceSource: "pet-chat-external",
        // Managers reason about the host-selected attachment references in pet-world;
        // inspecting/executing files still belongs in a delegated Work Session.
      })
      .finally(() => {
        reporting = false;
      });
    const failed =
      !outcome.ok && outcome.reason !== "aborted_streaming" && outcome.reason !== "aborted_tools";
    const failure = outcome.text || "外部聊天执行失败，未切换到 API 模型。";
    const finalState = manager.readSessionState(sessionId);
    const promptTokens = Math.max(
      0,
      (finalState?.tokenUsage?.promptTokens ?? 0) - (usageBefore?.promptTokens ?? 0),
    );
    const completionTokens = Math.max(
      0,
      (finalState?.tokenUsage?.completionTokens ?? 0) - (usageBefore?.completionTokens ?? 0),
    );
    const result: EngineResult = {
      sessionId,
      ...(finalState?.runId ? { runId: finalState.runId } : {}),
      text: outcome.text ?? "",
      reason: outcome.reason,
      ...(outcome.completionKind ? { completionKind: outcome.completionKind } : {}),
      turnCount: 1,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      extensions: {
        externalManagerModel: model,
        externalManagerInputHash: inputHash,
        ...(!failed && Object.keys(results).length ? { pet: results } : {}),
        ...(failed ? { externalRuntimeFailure: failure } : {}),
      },
    };
    // Persist BEFORE the dispatcher executes any deferred host action. The same
    // upstream message can be replayed after an app/gateway restart without a
    // second provider request; host-action receipts guard the side effects.
    if (clientMessageId) {
      const transcript = manager.resume(sessionId).transcript;
      transcript.appendRunResult(clientMessageId, result);
      if (transcript.flushFailed())
        throw new Error("外部聊天回复未能保存，请查看原会话；未重复执行。");
    }
    return failed ? { ok: false, message: failure } : { ok: true, result };
  }

  return {
    run(params: Record<string, unknown>): Promise<Response> {
      const sessionId = params.sessionId;
      assertDesktopSessionId(sessionId);
      const generation = generations.get(sessionId) ?? 0;
      const operation = (tails.get(sessionId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => runExclusive(params, generation));
      tails.set(sessionId, operation);
      void operation
        .finally(() => {
          if (tails.get(sessionId) === operation) tails.delete(sessionId);
        })
        .catch(() => undefined);
      return operation;
    },
    async stop(sessionId: string): Promise<void> {
      assertDesktopSessionId(sessionId);
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
      const service = deps.service();
      if (!service) throw new Error("外部聊天运行时尚未就绪。");
      await service.stop(sessionId);
    },
    resetContext,
  };
}
