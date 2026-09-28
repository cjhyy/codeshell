import { createHash } from "node:crypto";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";
import type {
  GatewayControlEventInput,
  PetChatControlRequest,
  SessionRouteControlRequest,
} from "../im-gateway-control-server.js";

type Decision = { approved: boolean; answer?: string; reason?: string; failure?: "timed_out" };
interface Envelope {
  sessionId: string;
  requestId: string;
  connectionId?: string;
  generation?: number;
  request: { toolName: string; description?: string; args: Record<string, unknown> };
}
export interface ImDecision {
  code: string;
  createdAt: number;
  task: PetLongTask;
  envelope: Envelope;
}

/** Join only live, user-visible worker requests to their host-owned origin. */
export function collectImDecisions(
  snapshot: DesktopPetProjectionSnapshot,
  tasks: readonly PetLongTask[],
  lines: readonly string[],
): ImDecision[] {
  const envelopes = new Map<string, Envelope>();
  for (const line of lines) {
    try {
      const frame = JSON.parse(line);
      const env = frame.params as Envelope;
      if (frame.method === "agent/approvalRequest" && env?.request?.args && env.requestId) {
        envelopes.set(`${env.sessionId}\0${env.requestId}`, env);
      }
    } catch {
      /* Ignore unrelated/malformed transport frames. */
    }
  }
  const result: ImDecision[] = [];
  for (const pending of snapshot.pending) {
    if (pending.status !== "pending") continue;
    const task = tasks.find(
      (entry) =>
        entry.sessionId === pending.agentSessionId &&
        !["completed", "failed", "cancelled"].includes(entry.status),
    );
    if (!task?.completionTarget) continue;
    const envelope = envelopes.get(`${pending.agentSessionId}\0${pending.requestId}`);
    if (!envelope || envelope.generation !== pending.routeGeneration) continue;
    // Bind the code to this worker and request, never a mutable "current task".
    const code = createHash("sha256")
      .update(
        JSON.stringify([
          pending.workerGeneration,
          envelope.connectionId,
          envelope.generation,
          envelope.sessionId,
          envelope.requestId,
        ]),
      )
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
    result.push({ code, createdAt: pending.createdAt, task, envelope });
  }
  return result;
}

function choices(entry: ImDecision): string[] {
  const args = entry.envelope.request.args;
  return Array.isArray(args.options)
    ? args.options.flatMap((option) =>
        option && typeof option.label === "string" ? [option.label] : [],
      )
    : [];
}

function canReply(entry: ImDecision): boolean {
  const origin = entry.task.completionTarget!;
  return origin.isDirectMessage === true && !!origin.senderId;
}

function questionBody(entry: ImDecision): string | undefined {
  const { toolName, description, args } = entry.envelope.request;
  const question =
    toolName === "__ask_user__"
      ? String(args.question ?? description ?? "需要你的回答")
      : `${toolName}\n${description ?? "工具请求执行许可"}\n${JSON.stringify(args, null, 2)}`;
  const options =
    toolName !== "__ask_user__"
      ? ["允许本次", "拒绝"]
      : Array.isArray(args.options)
        ? args.options.flatMap((option) =>
            option && typeof option.label === "string"
              ? [
                  `${option.label}${typeof option.description === "string" && option.description ? ` — ${option.description}` : ""}`,
                ]
              : [],
          )
        : [];
  const body = [question, ...options.map((label, index) => `${index + 1}. ${label}`)].join("\n");
  return body.length <= 12_000 ? body : undefined;
}

function event(entry: ImDecision, suffix: string, text: string): GatewayControlEventInput {
  const origin = entry.task.completionTarget!;
  return {
    deliveryKey: createHash("sha256").update(`pet-decision:${entry.code}:${suffix}`).digest("hex"),
    type: "pet.task.reported",
    title: "Mimi 任务确认",
    text,
    target: { channel: origin.channel, target: origin.target },
  };
}

/** Deterministic IM reply handling; no model may infer or manufacture consent. */
export class PetImDecisions {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly sent = new Set<string>();
  private readonly submitting = new Set<string>();
  private readonly notices = new Map<string, GatewayControlEventInput>();
  constructor(
    private readonly options: {
      read: () => ImDecision[];
      approve: (entry: ImDecision, decision: Decision) => Promise<void>;
      publish: (event: GatewayControlEventInput) => Promise<void>;
      onError: (error: unknown) => void;
      now?: () => number;
      graceMs?: number;
      timeoutMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref?.();
    void this.tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private expired(entry: ImDecision): boolean {
    return this.now() >= entry.createdAt + (this.options.timeoutMs ?? 10 * 60_000);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const entries = this.options.read();
      const live = new Set(entries.map((entry) => entry.code));
      for (const code of this.sent) if (!live.has(code)) this.sent.delete(code);
      for (const entry of entries) {
        if (this.submitting.has(entry.code)) continue;
        if (this.expired(entry)) {
          this.submitting.add(entry.code);
          try {
            // Re-read immediately before submitting; cancellation/restart wins.
            if (!this.options.read().some((item) => item.code === entry.code)) continue;
            await this.options.approve(entry, {
              approved: false,
              failure: "timed_out",
              reason:
                "IM confirmation timed out without an answer. No permission was granted. Skip the blocked operation and report the limitation; do not retry it or assume consent.",
            });
            this.notices.set(
              entry.code,
              event(
                entry,
                "expired",
                `确认 ${entry.code} 已超时，本次操作未获授权。任务将收到阻塞原因；如需继续此操作，请重新发起任务。`,
              ),
            );
          } catch (error) {
            this.options.onError(error);
          } finally {
            this.submitting.delete(entry.code);
          }
          continue;
        }
        if (
          this.sent.has(entry.code) ||
          this.now() - entry.createdAt < (this.options.graceMs ?? 15_000)
        )
          continue;
        try {
          await this.options.publish(event(entry, "question", this.prompt(entry)));
          this.sent.add(entry.code);
        } catch (error) {
          this.options.onError(error);
        }
      }
      for (const [code, notice] of this.notices) {
        try {
          await this.options.publish(notice);
          this.notices.delete(code);
        } catch (error) {
          this.options.onError(error);
        }
      }
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.ticking = false;
    }
  }

  private prompt(entry: ImDecision): string {
    const remaining = Math.max(
      1,
      Math.ceil((entry.createdAt + (this.options.timeoutMs ?? 600_000) - this.now()) / 60_000),
    );
    const deadline = `请在 ${remaining} 分钟内处理；超时不会授权本次操作。`;
    // Existing tasks lack sender identity; group conversations must not receive
    // private permission details or gain authority through a guessed reply code.
    if (!canReply(entry)) return `任务正在等待确认，请打开桌面 Session 处理。\n${deadline}`;
    const request = entry.envelope.request;
    const args = request.args;
    const body = questionBody(entry);
    if (!body)
      return `确认 ${entry.code} 内容较长，请打开桌面 Session 查看完整内容后处理。\n${deadline}`;
    const labels = choices(entry);
    const options = request.toolName !== "__ask_user__" ? ["允许本次", "拒绝"] : labels;
    const instructions =
      args.multiSelect === true
        ? `回复「回答 ${entry.code} 1,2」选择多个选项。`
        : options.length > 0
          ? `回复「回答 ${entry.code} 1」选择第 1 项。`
          : `回复「回答 ${entry.code} 你的答案」。`;
    return [
      `确认 ${entry.code}`,
      body,
      instructions,
      `回复「回答 ${entry.code} 拒绝」可跳过。`,
      deadline,
    ].join("\n");
  }

  /** The gateway probes bound Sessions before it reaches the Pet chat endpoint. */
  async replyToSession(
    request: SessionRouteControlRequest,
  ): Promise<{ kind: "status"; text: string } | undefined> {
    const text = await this.reply({ message: request.text, origin: request });
    return text === undefined ? undefined : { kind: "status", text };
  }

  async reply(request: {
    message: string;
    origin?: Pick<
      NonNullable<PetChatControlRequest["origin"]>,
      "channel" | "target" | "senderId" | "isDirectMessage"
    >;
  }): Promise<string | undefined> {
    const match = /^(?:回答|\/decision)\s+([a-f0-9]{12})\s+([\s\S]+)$/iu.exec(
      request.message.trim(),
    );
    if (!match) return undefined;
    const code = match[1]!.toUpperCase();
    const entry = this.options.read().find((item) => item.code === code);
    const origin = request.origin;
    const target = entry?.task.completionTarget;
    if (
      !entry ||
      !target ||
      !canReply(entry) ||
      origin?.isDirectMessage !== true ||
      origin.channel !== target.channel ||
      origin.target !== target.target ||
      origin.senderId !== target.senderId
    ) {
      return "该确认已结束，或不属于当前私聊。未执行任何操作。";
    }
    if (this.expired(entry)) {
      await this.tick();
      return "该确认已超时，未采用这条回答。";
    }
    if (this.submitting.has(code)) return "该确认正在处理，请勿重复提交。";
    const answer = match[2]!.trim();
    if (answer.length > 12_000) return "回答过长，请缩短后重试。";
    if (answer !== "拒绝" && !questionBody(entry))
      return "请在桌面 Session 查看完整确认内容后处理；也可以回复拒绝。";
    let decision: Decision;
    if (answer === "拒绝")
      decision = { approved: false, reason: "User declined via the originating IM conversation" };
    else if (entry.envelope.request.toolName !== "__ask_user__") {
      if (!["1", "2", "允许本次"].includes(answer)) return "请回复选项 1（允许本次）或 2（拒绝）。";
      decision = {
        approved: answer !== "2",
        ...(answer === "2" ? { reason: "User declined via IM" } : {}),
      };
    } else {
      const labels = choices(entry);
      const args = entry.envelope.request.args;
      const indexes = /^\d+(?:\s*[,，]\s*\d+)*$/u.test(answer)
        ? answer.split(/\s*[,，]\s*/u).map(Number)
        : [];
      const valid =
        indexes.length > 0 &&
        indexes.every((index) => index >= 1 && index <= labels.length) &&
        (args.multiSelect === true || indexes.length === 1);
      const mapped = valid ? indexes.map((index) => labels[index - 1]!).join(", ") : answer;
      if (
        labels.length > 0 &&
        ((indexes.length > 0 && !valid) ||
          (args.optionsOnly === true && !valid && !labels.includes(answer)))
      ) {
        return "选项无效，请按确认消息中的编号回答。";
      }
      decision = { approved: true, answer: mapped };
    }
    this.submitting.add(code);
    try {
      await this.options.approve(entry, decision);
      return `确认 ${code} 已处理${decision.approved ? "，回答已交给原任务" : "，本次操作未授权"}。`;
    } catch (error) {
      this.options.onError(error);
      return "确认未提交成功，可能已在其他端处理。请查看任务状态后重试。";
    } finally {
      this.submitting.delete(code);
    }
  }
}
