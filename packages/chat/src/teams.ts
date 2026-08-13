import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  ActivityTypes,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
} from "botbuilder";
import type { ChannelMessageHandler, OutgoingMessage, WebhookChannelAdapter } from "./channel.js";
import { BUILTIN_CHANNEL_CAPABILITIES } from "./channel.js";
import { formatOutgoingMarkdown, waitForAbort } from "./lifecycle.js";
import { mediaKind, outgoingAttachments, remoteAttachment, safeAttachmentName } from "./media.js";
import { readRequestBody, sendResponse } from "./webhook.js";

export interface TeamsAdapterConfig {
  appId: string;
  appPassword: string;
  appType?: string;
  tenantId?: string;
  statePath?: string;
}

const MAX_TEAMS_STATE_BYTES = 4 * 1024 * 1024;
const MAX_TEAMS_REFERENCES = 1_000;
const MAX_TEAMS_REFERENCE_BYTES = 64 * 1024;

export class TeamsAdapter implements WebhookChannelAdapter {
  readonly channel = "teams";
  readonly capabilities = BUILTIN_CHANNEL_CAPABILITIES.teams;
  readonly combinesTextAndAttachmentsAtomically = true;
  readonly webhookPath = "/webhooks/teams";
  private readonly adapter: CloudAdapter;
  private readonly appId: string;
  private readonly contexts = new Map<string, TurnContext>();
  private readonly references = new Map<
    string,
    ReturnType<typeof TurnContext.getConversationReference>
  >();
  private readonly statePath?: string;

  constructor(config: TeamsAdapterConfig) {
    this.appId = config.appId;
    this.statePath = config.statePath;
    const authentication = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppType: config.appType ?? "MultiTenant",
      MicrosoftAppId: config.appId,
      MicrosoftAppPassword: config.appPassword,
      ...(config.tenantId ? { MicrosoftAppTenantId: config.tenantId } : {}),
    });
    this.adapter = new CloudAdapter(authentication);
    this.loadReferences();
  }

  run(_handler: ChannelMessageHandler, signal: AbortSignal): Promise<void> {
    return waitForAbort(signal);
  }

  async handleWebhook(
    request: IncomingMessage,
    response: ServerResponse,
    handler: ChannelMessageHandler,
    maxBodyBytes: number,
  ): Promise<void> {
    if (request.method !== "POST") {
      sendResponse(response, 405, "Method not allowed");
      return;
    }
    const raw = await readRequestBody(request, maxBodyBytes);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      sendResponse(response, 400, "Invalid JSON");
      return;
    }
    await this.adapter.process(
      { method: request.method, headers: request.headers, body },
      new BotFrameworkResponse(response),
      async (context) => {
        const activity = context.activity;
        const target = activity.conversation?.id;
        const senderId = activity.from?.id;
        if (activity.type !== ActivityTypes.Message || !target || !senderId) return;
        const text = activity.text
          ? TurnContext.removeRecipientMention(activity).trim() || activity.text
          : "";
        const attachments = (activity.attachments ?? []).flatMap((attachment, index) => {
          const contentType = attachment.contentType?.toLowerCase() ?? "";
          if (
            contentType.startsWith("application/vnd.microsoft.card.") ||
            contentType === "text/html"
          ) {
            return [];
          }
          const downloadInfo =
            contentType === "application/vnd.microsoft.teams.file.download.info" &&
            attachment.content &&
            typeof attachment.content === "object"
              ? (attachment.content as {
                  downloadUrl?: string;
                  fileType?: string;
                  uniqueId?: string;
                })
              : undefined;
          const url = downloadInfo?.downloadUrl ?? attachment.contentUrl;
          if (!url) return [];
          const mimeType =
            downloadInfo?.fileType && downloadInfo.fileType.includes("/")
              ? downloadInfo.fileType
              : contentType === "application/vnd.microsoft.teams.file.download.info"
                ? undefined
                : attachment.contentType;
          const id = downloadInfo?.uniqueId ?? `${activity.id ?? target}:${index}`;
          return [
            remoteAttachment({
              id,
              kind: mediaKind(mimeType, attachment.name),
              name: safeAttachmentName(attachment.name, `teams-${id}`),
              mimeType,
              url,
            }),
          ];
        });
        if (!text && attachments.length === 0) return;
        this.references.set(target, TurnContext.getConversationReference(activity));
        this.saveReferences();
        this.contexts.set(target, context);
        try {
          await handler({
            channel: this.channel,
            target,
            senderId,
            text,
            ...(activity.id ? { messageId: activity.id } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          });
        } finally {
          this.contexts.delete(target);
        }
      },
    );
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    const context = this.contexts.get(target);
    const text = formatOutgoingMarkdown(message.text, message.button);
    const outgoing = outgoingAttachments(message, this.capabilities.outbound.attachments);
    const maximum = this.capabilities.outbound.maxAttachmentBytes ?? 1024 * 1024;
    if (outgoing.some((attachment) => attachment.data.byteLength > maximum)) {
      throw new Error(`Teams 内联图片不能超过 ${maximum} 字节`);
    }
    const attachments = outgoing.map((attachment) => ({
      contentType: attachment.mimeType,
      contentUrl: `data:${attachment.mimeType};base64,${Buffer.from(attachment.data).toString("base64")}`,
      name: safeAttachmentName(attachment.name),
    }));
    const activity = {
      type: ActivityTypes.Message,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    if (context) {
      await context.sendActivity(activity);
      return;
    }
    const reference = this.references.get(target);
    if (!reference) throw new Error(`Teams 会话 ${target} 尚无 conversation reference`);
    await this.adapter.continueConversationAsync(this.appId, reference, async (turn) => {
      await turn.sendActivity(activity);
    });
  }

  private loadReferences(): void {
    if (!this.statePath) return;
    let fd: number | undefined;
    try {
      const entry = lstatSync(this.statePath);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_TEAMS_STATE_BYTES) return;
      fd = openSync(this.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_TEAMS_STATE_BYTES) return;
      const parsed = JSON.parse(readFileSync(fd, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [target, reference] of Object.entries(parsed as Record<string, unknown>).slice(
        0,
        MAX_TEAMS_REFERENCES,
      )) {
        if (validTeamsConversationReference(target, reference)) {
          this.references.set(
            target,
            reference as ReturnType<typeof TurnContext.getConversationReference>,
          );
        }
      }
    } catch {
      // First run, malformed legacy state, or an unavailable home directory.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private saveReferences(): void {
    if (!this.statePath) return;
    const entries = [...this.references.entries()]
      .filter(([target, reference]) => validTeamsConversationReference(target, reference))
      .slice(-MAX_TEAMS_REFERENCES);
    const serialized = `${JSON.stringify(Object.fromEntries(entries))}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_TEAMS_STATE_BYTES) {
      throw new Error("Teams conversation state is too large");
    }
    const parent = dirname(this.statePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new Error("Teams conversation state parent must be a real directory");
    }
    try {
      const targetInfo = lstatSync(this.statePath);
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
        throw new Error("Teams conversation state must be a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, serialized, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.statePath);
      if (process.platform !== "win32") chmodSync(this.statePath, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function validTeamsConversationReference(target: string, value: unknown): boolean {
  if (!target || target.length > 4_096 || /[\0\r\n]/u.test(target)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TEAMS_REFERENCE_BYTES) return false;
  const reference = value as Record<string, unknown>;
  if (reference.channelId !== "msteams" || typeof reference.serviceUrl !== "string") return false;
  if (reference.serviceUrl.length > 2_048) return false;
  try {
    const url = new URL(reference.serviceUrl);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return false;
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) return false;
    if (/^(?:127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname)) {
      return false;
    }
  } catch {
    return false;
  }
  const conversation = reference.conversation;
  return (
    Boolean(conversation) &&
    typeof conversation === "object" &&
    !Array.isArray(conversation) &&
    (conversation as Record<string, unknown>).id === target
  );
}

class BotFrameworkResponse {
  readonly socket: unknown;

  constructor(private readonly response: ServerResponse) {
    this.socket = response.socket;
  }

  status(code: number): this {
    this.response.statusCode = code;
    return this;
  }

  header(name: string, value: unknown): this {
    this.response.setHeader(name, String(value));
    return this;
  }

  send(...args: unknown[]): this {
    const body = args.at(-1);
    if (body !== undefined) {
      this.response.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    return this;
  }

  end(...args: unknown[]): this {
    this.response.end(...(args as []));
    return this;
  }
}
