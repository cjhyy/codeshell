import { createHash } from "node:crypto";
import { USER_DECISION_TIMEOUT_MS, recommendedAnswer } from "@cjhyy/code-shell-core/internal";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeAttention, NoticeChannel } from "@cjhyy/code-shell-pet/protocol";
import type { DesktopPetProjectionSnapshot } from "./pet-state-aggregator.js";
import type {
  PetChatControlRequest,
  SessionRouteControlRequest,
} from "../im-gateway-control-server.js";
import { MAX_NOTICE_BODY } from "./pet-notice-compose.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import type { NoticeSubmission, NoticeTarget } from "./pet-notice-types.js";

type Decision = { approved: boolean; answer?: string; reason?: string; failure?: "timed_out" };
interface Envelope {
  sessionId: string;
  requestId: string;
  connectionId?: string;
  generation?: number;
  expiresAt?: number;
  request: { toolName: string; description?: string; args: Record<string, unknown> };
}
/** Where one decision's prompt is routed, and so who may answer it. */
export interface ImDecisionDelivery {
  /** Notice rules that asked to hear about this Session blocking. */
  ruleIds: string[];
  attention: NoticeAttention;
  channel: NoticeChannel;
  /** A route is the conversation answers must come from; owner = the owner's direct chats. */
  target: NoticeTarget;
  /** Only the all-sessions system rule matched: prompt only while the owner is away. */
  requiresAway?: boolean;
  /** The owner started this task from that IM conversation: it is answered there. */
  reply: boolean;
}

/** A Session's active blocked-watching rules, resolved by the notice wiring. */
export type ImDecisionRuleDelivery = Omit<ImDecisionDelivery, "reply">;

export interface ImDecision {
  code: string;
  createdAt: number;
  expiresAt?: number;
  /** The Session's title, for the notice's facts. */
  title?: string;
  /** The active long task that owns this Session, when there is one. */
  task?: PetLongTask;
  envelope: Envelope;
  delivery: ImDecisionDelivery;
}

/** Room left in a prompt for the code, instructions and deadline lines. */
const PROMPT_OVERHEAD = 400;
/** A question longer than this is only reviewable (and answerable) on the desktop. */
const QUESTION_BODY_MAX = MAX_NOTICE_BODY - PROMPT_OVERHEAD;

/**
 * Join only live, user-visible worker requests to where they are answered: the
 * IM conversation that started the Session's long task, else the Session's
 * active blocked-watching notice rules (`rulesFor`; the Session is blocked
 * now, so a rule armed after the request appeared still counts). Decisions
 * with neither stay desktop-only.
 */
export function collectImDecisions(
  snapshot: DesktopPetProjectionSnapshot,
  tasks: readonly PetLongTask[],
  lines: readonly string[],
  rulesFor?: (sessionId: string) => ImDecisionRuleDelivery | undefined,
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
    const origin = task?.completionTarget;
    let delivery: ImDecisionDelivery | undefined;
    if (origin) {
      delivery = {
        ruleIds: rulesFor?.(pending.agentSessionId)?.ruleIds ?? [],
        attention: "always",
        channel: origin.channel,
        target: { kind: "route", route: origin },
        reply: true,
      };
    } else {
      const rules = rulesFor?.(pending.agentSessionId);
      if (rules) delivery = { ...rules, reply: false };
    }
    if (!delivery) continue;
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
    const title = snapshot.sessions.find(
      (session) => session.agentSessionId === pending.agentSessionId,
    )?.title;
    result.push({
      code,
      createdAt: pending.createdAt,
      ...(title ? { title } : {}),
      delivery,
      ...(task ? { task } : {}),
      // A model question's live envelope owns its deadline: keeping it open
      // republishes the request without one, while observer metadata lags.
      expiresAt: skippableEnvelope(envelope)
        ? envelope.expiresAt
        : (envelope.expiresAt ?? pending.expiresAt),
      task,
      envelope,
    });
  }
  return result;
}

/** Model questions (AskUserQuestion*) — Core resolves their timeout itself. */
function skippableEnvelope(envelope: Envelope): boolean {
  return envelope.request.toolName === "__ask_user__" && envelope.request.args.skippable === true;
}

/** The recommended label(s) a timed-out model question defaults to (Core's rule). */
function recommended(entry: ImDecision): string | undefined {
  const args = entry.envelope.request.args;
  const options = Array.isArray(args.options)
    ? args.options.flatMap((option) =>
        option && typeof option.label === "string"
          ? [
              {
                label: option.label as string,
                description: "",
                recommended: option.recommended === true,
              },
            ]
          : [],
      )
    : [];
  return recommendedAnswer({ options, multiSelect: args.multiSelect === true });
}

function choices(entry: ImDecision): string[] {
  const args = entry.envelope.request.args;
  return Array.isArray(args.options)
    ? args.options.flatMap((option) =>
        option && typeof option.label === "string" ? [option.label] : [],
      )
    : [];
}

/**
 * Only a private chat with an authenticated sender may answer: a route must be
 * a direct message with a sender; owner prompts go to the owner's own direct
 * chats, recognised by `isOwnerConversation`.
 */
function canReply(entry: ImDecision, ownerConversations: boolean): boolean {
  const target = entry.delivery.target;
  if (target.kind === "owner") return ownerConversations;
  return target.route.isDirectMessage === true && !!target.route.senderId;
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
                  `${option.label}${option.recommended === true ? "（推荐）" : ""}${typeof option.description === "string" && option.description ? ` — ${option.description}` : ""}`,
                ]
              : [],
          )
        : [];
  const body = [question, ...options.map((label, index) => `${index + 1}. ${label}`)].join("\n");
  return body.length <= QUESTION_BODY_MAX ? body : undefined;
}

/**
 * The question and options as notice facts (digest lines, replayed context).
 * A conversation that cannot answer gets neither the details nor the code.
 */
function decisionFacts(entry: ImDecision, answerable: boolean): NoticeSubmission["facts"] {
  if (!answerable) return entry.title ? { title: entry.title } : {};
  const { toolName, description, args } = entry.envelope.request;
  const question =
    toolName === "__ask_user__"
      ? String(args.question ?? description ?? "需要你的回答")
      : `${toolName}：${description ?? "工具请求执行许可"}`;
  const options =
    toolName !== "__ask_user__"
      ? [{ label: "允许本次" }, { label: "拒绝" }]
      : Array.isArray(args.options)
        ? args.options.flatMap((option) =>
            option && typeof option.label === "string"
              ? [
                  {
                    label: option.label as string,
                    ...(option.recommended === true ? { recommended: true } : {}),
                  },
                ]
              : [],
          )
        : [];
  return {
    ...(entry.title ? { title: entry.title } : {}),
    question,
    ...(options.length > 0 ? { options } : {}),
    code: entry.code,
  };
}

/** The channel a submitted notice went out on over IM, if it did. */
function imChannel(decision: RouteDecision | undefined): string | undefined {
  return decision && (decision.outlet === "im" || decision.outlet === "both")
    ? decision.im
    : undefined;
}

/**
 * Deterministic IM reply handling; no model may infer or manufacture consent.
 *
 * This is the only source of IM prompts for pending decisions: after a grace
 * period each prompt (with its reply code) is submitted to the notice router,
 * which decides whether it goes to IM at all (presence, the all-sessions
 * rule's "only while away", P0 caps) and where. A prompt the router kept on
 * the desktop is never sent; its code is never shown, so it cannot be
 * answered from IM.
 */
export class PetImDecisions {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private retick = false;
  /** Codes whose prompt was handed to the router (sent or deliberately not). */
  private readonly sent = new Set<string>();
  /** Codes whose prompt the router sent over IM → that channel. */
  private readonly prompted = new Map<string, string>();
  private readonly submitting = new Set<string>();
  private readonly notices = new Map<string, NoticeSubmission>();
  /** Retain delivered prompts briefly so late short replies receive an explicit ended notice. */
  private readonly delivered = new Map<string, { entry: ImDecision; at: number }>();
  constructor(
    private readonly options: {
      read: () => ImDecision[];
      approve: (entry: ImDecision, decision: Decision) => Promise<void>;
      /** Drop a model question's auto-resolve deadline (回答 码 等待). */
      keepWaiting?: (entry: ImDecision) => Promise<void>;
      /** The notice router (`PetNoticeRouter.submit`); its decision says whether IM got it. */
      submit: (notice: NoticeSubmission) => Promise<RouteDecision | undefined>;
      /** A direct chat that belongs to the owner, for owner-targeted prompts. */
      isOwnerConversation?: (origin: {
        channel: string;
        target: string;
        senderId?: string;
      }) => boolean;
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
  /** A notice rule saw this Session block: look now instead of at the next poll. */
  considerSession(_sessionId: string): void {
    if (!this.timer) return;
    void this.tick();
  }
  private canReply(entry: ImDecision): boolean {
    return canReply(entry, this.options.isOwnerConversation !== undefined);
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private expired(entry: ImDecision): boolean {
    return this.now() >= this.expiresAt(entry);
  }
  private expiresAt(entry: ImDecision): number {
    if (Number.isFinite(entry.expiresAt)) return entry.expiresAt!;
    // A model question without a deadline waits until it is answered.
    if (skippableEnvelope(entry.envelope)) return Number.POSITIVE_INFINITY;
    return entry.createdAt + (this.options.timeoutMs ?? USER_DECISION_TIMEOUT_MS);
  }
  private sameOrigin(
    entry: ImDecision,
    origin: Parameters<PetImDecisions["reply"]>[0]["origin"],
  ): boolean {
    if (!origin || origin.isDirectMessage !== true || !this.canReply(entry)) return false;
    const target = entry.delivery.target;
    if (target.kind === "owner") {
      return (
        this.options.isOwnerConversation?.({
          channel: origin.channel,
          target: origin.target,
          ...(origin.senderId !== undefined ? { senderId: origin.senderId } : {}),
        }) === true
      );
    }
    return (
      origin.channel === target.route.channel &&
      origin.target === target.route.target &&
      origin.senderId === target.route.senderId
    );
  }
  private pruneDelivered(): void {
    for (const [code, item] of this.delivered) {
      const end = this.expiresAt(item.entry);
      if (this.now() > Math.max(Number.isFinite(end) ? end : 0, item.at) + USER_DECISION_TIMEOUT_MS)
        this.delivered.delete(code);
    }
    while (this.delivered.size > 256) this.delivered.delete(this.delivered.keys().next().value!);
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      this.retick = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.retick = false;
        await this.tickOnce();
      } while (this.retick);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    try {
      const entries = this.options.read();
      this.pruneDelivered();
      const live = new Set(entries.map((entry) => entry.code));
      for (const code of this.sent) if (!live.has(code)) this.sent.delete(code);
      for (const code of this.prompted.keys()) if (!live.has(code)) this.prompted.delete(code);
      for (const entry of entries) {
        if (this.submitting.has(entry.code)) continue;
        if (this.expired(entry)) {
          // Core applies a model question's timeout (recommended option or skip).
          if (skippableEnvelope(entry.envelope)) continue;
          // Core enforces the same deadline itself; this backstop (and its
          // notice) is only for decisions that were put to an IM conversation.
          const channel =
            this.prompted.get(entry.code) ??
            (entry.delivery.reply && entry.delivery.target.kind === "route"
              ? entry.delivery.target.route.channel
              : undefined);
          if (channel === undefined) continue;
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
              this.expiredNotice(
                entry,
                channel,
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
          const decision = await this.options.submit(this.questionNotice(entry));
          this.sent.add(entry.code);
          const channel = imChannel(decision);
          if (channel !== undefined) {
            this.prompted.set(entry.code, channel);
            this.delivered.set(entry.code, { entry, at: this.now() });
          }
        } catch (error) {
          this.options.onError(error);
        }
      }
      for (const [code, notice] of this.notices) {
        try {
          await this.options.submit(notice);
          this.notices.delete(code);
        } catch (error) {
          this.options.onError(error);
        }
      }
    } catch (error) {
      this.options.onError(error);
    }
  }

  /** One P0 blocked notice per request; the router owns quiet hours, presence and caps. */
  private questionNotice(entry: ImDecision): NoticeSubmission {
    const { sessionId, requestId } = entry.envelope;
    const { delivery } = entry;
    const end = this.expiresAt(entry);
    return {
      kind: "session.blocked",
      priority: "P0",
      dedupeKey: `${sessionId}:${requestId}`,
      sessionId,
      requestId,
      ...(Number.isFinite(end) ? { expiresAt: end } : {}),
      ruleIds: delivery.ruleIds,
      ...(delivery.requiresAway ? { requiresAway: true } : {}),
      facts: decisionFacts(entry, this.canReply(entry)),
      attention: delivery.attention,
      channel: delivery.channel,
      target: delivery.target,
      body: this.prompt(entry),
      ...(delivery.reply ? { reply: true } : {}),
    };
  }

  /** Tells the conversation that got the prompt that it ended unanswered. */
  private expiredNotice(entry: ImDecision, channel: string, text: string): NoticeSubmission {
    const { sessionId, requestId } = entry.envelope;
    return {
      kind: "decision.expired",
      priority: "P1",
      dedupeKey: `${sessionId}:${requestId}:expired`,
      sessionId,
      ruleIds: entry.delivery.ruleIds,
      facts: entry.title ? { title: entry.title } : {},
      attention: "always",
      // The channel the prompt went out on, so the notice follows it there.
      channel,
      target: entry.delivery.target,
      body: text,
      reply: true,
    };
  }

  private prompt(entry: ImDecision): string {
    const question = skippableEnvelope(entry.envelope);
    const end = this.expiresAt(entry);
    const remaining = Math.max(1, Math.ceil((end - this.now()) / 60_000));
    const deadline = !question
      ? `剩余约 ${remaining} 分钟；电脑、微信和已连接的手机遥控共用截止时间，超时不会授权本次操作。`
      : !Number.isFinite(end)
        ? "这个问题会一直等你回答。"
        : `剩余约 ${remaining} 分钟；超时未回答将自动按默认处理。`;
    // Existing tasks lack sender identity; group conversations must not receive
    // private permission details or gain authority through a guessed reply code.
    if (!this.canReply(entry)) return `任务正在等待确认，请打开桌面 Session 处理。\n${deadline}`;
    const fallback = question && Number.isFinite(end) ? recommended(entry) : undefined;
    const timeout =
      question && Number.isFinite(end)
        ? `剩余约 ${remaining} 分钟；超时未回答将${fallback !== undefined ? `自动选择推荐项「${fallback}」` : "自动跳过"}。回复「回答 ${entry.code} 等待」可一直等。`
        : deadline;
    const request = entry.envelope.request;
    const args = request.args;
    const body = questionBody(entry);
    if (!body)
      return `确认 ${entry.code} 内容较长，请打开桌面 Session 查看完整内容后处理。\n${timeout}`;
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
      "回答时请保留确认码；无需进入 Session。",
      `回复「回答 ${entry.code} ${question ? "跳过" : "拒绝"}」可跳过。`,
      timeout,
    ]
      .filter(Boolean)
      .join("\n");
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
    const message = request.message.trim();
    const match = /^(?:回答|\/decision)\s+([a-f0-9]{12})\s+([\s\S]+)$/iu.exec(message);
    this.pruneDelivered();
    const entries = this.options.read();
    const origin = request.origin;
    let code: string;
    let answer: string;
    if (match) {
      code = match[1]!.toUpperCase();
      answer = match[2]!.trim();
    } else {
      const delivered = [...this.delivered.values()].filter((item) =>
        this.sameOrigin(item.entry, origin),
      );
      // Owner prompts reach whichever owner chat the router picked, so only
      // one the router actually sent there is a candidate for a bare reply.
      const matching = entries.filter(
        (item) =>
          this.sameOrigin(item, origin) &&
          (item.delivery.target.kind === "route" || this.prompted.has(item.code)),
      );
      const shortReply =
        /^\d+(?:\s*[,，]\s*\d+)*$/u.test(message) ||
        [...matching, ...delivered.map(({ entry }) => entry)].some((entry) =>
          [
            "拒绝",
            // Only a model question can be skipped; a permission request is declined.
            ...(skippableEnvelope(entry.envelope) ? ["跳过"] : []),
            ...(entry.envelope.request.toolName === "__ask_user__" ? choices(entry) : ["允许本次"]),
          ].includes(message),
        );
      if (!shortReply) return undefined;
      const candidates = matching.filter((item) => !this.expired(item));
      if (candidates.length === 0) {
        if (delivered.length === 0 && matching.length === 0) return undefined;
        await this.tick();
        return "这条确认已结束或超时，未采用这条回答。无需进入 Session；如仍需该操作，请重新发起。";
      }
      if (candidates.length > 1) {
        return [
          "当前无法唯一匹配已送达的待确认，请带确认码回答，避免选错任务：",
          ...candidates.map((item) => `回答 ${item.code} <选项编号>`),
        ].join("\n");
      }
      const candidate = candidates[0]!;
      return [
        "单独的编号或选项还没有提交确认。当前待确认内容：",
        questionBody(candidate) ?? "请在电脑查看完整内容。",
        `核对后请回复「回答 ${candidate.code} ${message}」。无需进入 Session。`,
      ].join("\n");
    }
    const entry = entries.find((item) => item.code === code);
    if (!entry || !this.sameOrigin(entry, origin)) {
      return "该确认已结束，或不属于当前私聊。未执行任何操作。";
    }
    if (this.expired(entry)) {
      await this.tick();
      return "该确认已超时，未采用这条回答。";
    }
    if (this.submitting.has(code)) return "该确认正在处理，请勿重复提交。";
    if (answer.length > 12_000) return "回答过长，请缩短后重试。";
    const question = skippableEnvelope(entry.envelope);
    // An option literally named 等待/跳过 is an answer, not a command.
    const option = question && choices(entry).includes(answer);
    if (question && !option && ["等待", "一直等"].includes(answer)) {
      if (!Number.isFinite(this.expiresAt(entry))) return `确认 ${code} 已经在一直等待你的回答。`;
      if (!this.options.keepWaiting) return "当前无法改为一直等待，请在电脑上处理。";
      try {
        await this.options.keepWaiting(entry);
        return `确认 ${code} 已改为一直等待，想好后再回复「回答 ${code} 1」等即可。`;
      } catch (error) {
        this.options.onError(error);
        return "没能改为一直等待，可能已在其他端处理。请查看任务状态。";
      }
    }
    const skip = !option && (answer === "拒绝" || (question && answer === "跳过"));
    if (!skip && !questionBody(entry))
      return "请在桌面 Session 查看完整确认内容后处理；也可以回复拒绝。";
    let decision: Decision;
    if (skip)
      // No reason on a model question: Core reports a skip and the model continues.
      decision = question
        ? { approved: false }
        : { approved: false, reason: "User declined via the originating IM conversation" };
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
      return `确认 ${code} 已处理${decision.approved ? "，回答已交给原任务" : question ? "，已跳过这个问题" : "，本次操作未授权"}。`;
    } catch (error) {
      this.options.onError(error);
      return "确认未提交成功，可能已在其他端处理。请查看任务状态后重试。";
    } finally {
      this.submitting.delete(code);
    }
  }
}

type WorkerRequest = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  options: { meta: { origin: "host"; producer: string } },
) => Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;

/** Worker-side effects of an IM decision, kept out of the composition root. */
export function imDecisionWorkerActions(
  requestWorker: WorkerRequest,
  broadcastResolved: (params: {
    sessionId: string;
    requestId: string;
    connectionId?: string;
    generation?: number;
    approved: boolean;
    answer?: string;
  }) => void,
): Pick<ConstructorParameters<typeof PetImDecisions>[0], "approve" | "keepWaiting"> {
  const send = async (method: string, params: Record<string, unknown>, producer: string) => {
    const outcome = await requestWorker(method, params, 15_000, {
      meta: { origin: "host", producer },
    });
    if (!outcome.ok) throw new Error(outcome.message);
  };
  return {
    approve: async (entry, decision) => {
      const { request: _request, expiresAt: _expiresAt, ...route } = entry.envelope;
      await send("agent/approve", { ...route, decision }, "pet-im-decision");
      broadcastResolved({ ...route, approved: decision.approved, answer: decision.answer });
    },
    keepWaiting: async (entry) => {
      const { request: _request, expiresAt: _expiresAt, ...route } = entry.envelope;
      await send("agent/approvalKeepWaiting", route, "pet-im-keep-waiting");
    },
  };
}
