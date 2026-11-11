import { randomUUID } from "node:crypto";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import type { ExternalReplyModel } from "./pet-notice-reply-models.js";

/** Hidden, tool-free interpreter calls never share Mimi's conversation or cancel one another. */
export function createPetExternalReplyModel(deps: {
  service(): Pick<ExternalRuntimeService, "ensure" | "send" | "stop"> | null;
  cwd: string;
}): ExternalReplyModel {
  return async (modelKey, { systemPrompt, user, signal }) => {
    signal.throwIfAborted();
    const parsed = parseExternalRuntimeModelKey(modelKey);
    if (!parsed?.model) throw new Error("外部通知回复模型配置无效，未切换到 API 模型。");
    const service = deps.service();
    if (!service) throw new Error("外部通知回复模型尚未就绪，未切换到 API 模型。");
    const sessionId = `pet-reply-${randomUUID()}`;
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (deps.service() !== service) throw new Error("通知回复运行环境已改变，请重试。");
    };
    let stopping: Promise<void> | undefined;
    const stop = () => (stopping ??= service.stop(sessionId));
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    void aborted.catch(() => undefined);
    const onAbort = () => {
      rejectAbort(signal.reason ?? new Error("通知回复解读已取消。"));
      void stop().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      assertCurrent();
      await Promise.race([
        service.ensure({
          kind: parsed.kind,
          sessionId,
          cwd: deps.cwd,
          modelKey,
          model: parsed.model,
          permissionMode: "default",
          assertStartAuthority: assertCurrent,
          toolProfile: {
            id: "pet-notice-reply-interpreter",
            catalog: [],
            instructions: systemPrompt,
            context: {},
            services: () => ({}),
            visibility: () => ({ behaviorProfile: "pet" }),
            readOnly: true,
            disableMemory: true,
            sessionKind: "pet",
            maxToolCalls: 1,
          },
        }),
        aborted,
      ]);
      assertCurrent();
      const outcome = await Promise.race([
        service.send(sessionId, {
          text: user,
          injected: true,
          disableGoal: true,
          modelTraceSource: "pet-notice-reply-external",
        }),
        aborted,
      ]);
      assertCurrent();
      if (!outcome.ok) throw new Error(outcome.text || "外部通知回复解读失败，未切换到 API 模型。");
      return outcome.text ?? "";
    } finally {
      signal.removeEventListener("abort", onAbort);
      await stop();
    }
  };
}
