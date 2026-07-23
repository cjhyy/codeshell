import type {
  ToolContext,
  ToolDefinition,
  ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";

export const GATEWAY_TOOL_NAME = "Gateway";

export type PetGatewayAttachmentKind = "image" | "file" | "audio" | "video";

export interface PetGatewayChannelCapabilities {
  inbound: {
    text: true;
    attachments: readonly PetGatewayAttachmentKind[];
  };
  outbound: {
    text: true;
    maxTextLength?: number;
    button: "native" | "link";
    attachments: readonly PetGatewayAttachmentKind[];
    maxAttachments?: number;
    maxAttachmentBytes?: number;
  };
}

export interface PetGatewayChannel {
  channel: string;
  capabilities: PetGatewayChannelCapabilities;
}

/** Bounded adapter-owned capability catalog available during one Gateway turn. */
export interface PetGatewayCatalog {
  currentChannel: string;
  channels: readonly PetGatewayChannel[];
}

export const gatewayToolDef: ToolDefinition = {
  name: GATEWAY_TOOL_NAME,
  description:
    "First-level, read-only progressive discovery for Chat Gateway. Search only the channels " +
    "granted to this turn, or describe the exact inbound/outbound contract of one channel. " +
    "Use GatewayReply as the second-level execution tool for the current originating conversation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["search", "describe"],
        description:
          "search returns compact channel matches; describe returns one exact channel contract.",
      },
      query: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description:
          "Optional search terms. Omit to list every granted channel. Use terms such as " +
          "channel:telegram, inbound:file, outbound:image, button:native, or current.",
      },
      channel: {
        type: "string",
        minLength: 1,
        maxLength: 32,
        description:
          "Granted channel name for describe. Omit it to inspect the current originating channel.",
      },
    },
    required: ["action"],
  },
};

export function gatewayAvailability(ctx: ToolVisibilityContext): boolean {
  return Boolean(ctx.profileMeta?.petGateway);
}

export async function gatewayTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const catalog = (ctx?.runScopedServices as { petGateway?: PetGatewayCatalog } | undefined)
    ?.petGateway;
  if (!catalog) return "Error: Gateway is available only in a Mimi turn with Gateway context.";
  if (
    Object.keys(args).some((key) => !["action", "query", "channel"].includes(key)) ||
    typeof args.action !== "string"
  ) {
    return "Error: Gateway requires an action and accepts only query or channel.";
  }
  if (args.action === "search") {
    if (args.channel !== undefined) {
      return "Error: Gateway search does not accept channel.";
    }
    if (
      args.query !== undefined &&
      (typeof args.query !== "string" ||
        args.query.length < 1 ||
        args.query.length > 128 ||
        args.query.trim().length < 1)
    ) {
      return "Error: Gateway search query must be 1 to 128 non-blank characters.";
    }
    const query = typeof args.query === "string" ? args.query : undefined;
    return JSON.stringify({
      currentChannel: catalog.currentChannel,
      matches: catalog.channels
        .filter((entry) => matchesGatewayQuery(entry, catalog.currentChannel, query))
        .map(({ channel }) => ({
          channel,
          current: channel === catalog.currentChannel,
        })),
      next: `Call ${GATEWAY_TOOL_NAME} with action=describe and an optional matched channel, then use GatewayReply for the current route.`,
    });
  }
  if (args.action !== "describe") {
    return "Error: Gateway action must be search or describe.";
  }
  if (args.query !== undefined) {
    return "Error: Gateway describe does not accept query.";
  }
  if (
    args.channel !== undefined &&
    (typeof args.channel !== "string" || !isChannelName(args.channel))
  ) {
    return "Error: Gateway channel must be a configured channel name.";
  }
  const requested =
    typeof args.channel === "string" ? args.channel.toLowerCase() : catalog.currentChannel;
  const selected = catalog.channels.find(({ channel }) => channel === requested);
  if (!selected) {
    return `Error: channel ${requested} is not granted to this Gateway turn. Call search first.`;
  }
  return JSON.stringify({
    current: selected.channel === catalog.currentChannel,
    channel: selected.channel,
    capabilities: selected.capabilities,
    execution:
      selected.channel === catalog.currentChannel
        ? {
            tool: "GatewayReply",
            destination: "current originating IM conversation",
          }
        : {
            tool: null,
            reason: "GatewayReply is intentionally bound to the current originating conversation.",
          },
  });
}

function matchesGatewayQuery(
  entry: PetGatewayChannel,
  currentChannel: string,
  query?: string,
): boolean {
  if (query === undefined) return true;
  const terms = query.toLowerCase().trim().split(/\s+/u);
  return terms.every((term) => matchesGatewayTerm(entry, currentChannel, term));
}

function matchesGatewayTerm(
  entry: PetGatewayChannel,
  currentChannel: string,
  term: string,
): boolean {
  if (term === "current") return entry.channel === currentChannel;
  const [scope, value, extra] = term.split(":");
  if (extra !== undefined || value === "") return false;
  if (value !== undefined) {
    if (scope === "channel") return entry.channel.includes(value);
    if (scope === "button") return entry.capabilities.outbound.button === value;
    if (scope === "inbound") {
      return (
        value === "text" || entry.capabilities.inbound.attachments.includes(asAttachment(value))
      );
    }
    if (scope === "outbound") {
      return (
        value === "text" || entry.capabilities.outbound.attachments.includes(asAttachment(value))
      );
    }
    return false;
  }
  if (entry.channel.includes(term)) return true;
  if (entry.capabilities.outbound.button === term) return true;
  if (term === "text") return true;
  const attachment = asAttachment(term);
  return (
    entry.capabilities.inbound.attachments.includes(attachment) ||
    entry.capabilities.outbound.attachments.includes(attachment)
  );
}

function asAttachment(value: string): PetGatewayAttachmentKind {
  return value as PetGatewayAttachmentKind;
}

export function parsePetGatewayCatalog(value: unknown): PetGatewayCatalog | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["currentChannel", "channels"])) return undefined;
  if (!isChannelName(value.currentChannel) || !Array.isArray(value.channels)) return undefined;
  if (value.channels.length < 1 || value.channels.length > 32) return undefined;
  const channels: PetGatewayChannel[] = [];
  const names = new Set<string>();
  for (const raw of value.channels) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["channel", "capabilities"])) return undefined;
    if (!isChannelName(raw.channel) || names.has(raw.channel)) return undefined;
    const capabilities = parseCapabilities(raw.capabilities);
    if (!capabilities) return undefined;
    names.add(raw.channel);
    channels.push(Object.freeze({ channel: raw.channel, capabilities }));
  }
  if (!names.has(value.currentChannel)) return undefined;
  return Object.freeze({
    currentChannel: value.currentChannel,
    channels: Object.freeze(channels),
  });
}

function parseCapabilities(value: unknown): PetGatewayChannelCapabilities | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["inbound", "outbound"])) return undefined;
  if (
    !isRecord(value.inbound) ||
    !hasExactKeys(value.inbound, ["text", "attachments"]) ||
    value.inbound.text !== true
  ) {
    return undefined;
  }
  const inboundAttachments = parseAttachmentKinds(value.inbound.attachments);
  if (!inboundAttachments || !isRecord(value.outbound) || value.outbound.text !== true) {
    return undefined;
  }
  if (
    Object.keys(value.outbound).some(
      (key) =>
        ![
          "text",
          "maxTextLength",
          "button",
          "attachments",
          "maxAttachments",
          "maxAttachmentBytes",
        ].includes(key),
    ) ||
    (value.outbound.button !== "native" && value.outbound.button !== "link")
  ) {
    return undefined;
  }
  const outboundAttachments = parseAttachmentKinds(value.outbound.attachments);
  if (!outboundAttachments) return undefined;
  const maxTextLength = optionalBoundedInteger(value.outbound.maxTextLength, 1, 8_000);
  const maxAttachments = optionalBoundedInteger(value.outbound.maxAttachments, 1, 4);
  const maxAttachmentBytes = optionalBoundedInteger(
    value.outbound.maxAttachmentBytes,
    1,
    10 * 1024 * 1024,
  );
  if (maxTextLength === null || maxAttachments === null || maxAttachmentBytes === null) {
    return undefined;
  }
  return Object.freeze({
    inbound: Object.freeze({ text: true as const, attachments: inboundAttachments }),
    outbound: Object.freeze({
      text: true as const,
      ...(maxTextLength === undefined ? {} : { maxTextLength }),
      button: value.outbound.button,
      attachments: outboundAttachments,
      ...(maxAttachments === undefined ? {} : { maxAttachments }),
      ...(maxAttachmentBytes === undefined ? {} : { maxAttachmentBytes }),
    }),
  });
}

function parseAttachmentKinds(value: unknown): readonly PetGatewayAttachmentKind[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    !value.every((kind) => ["image", "file", "audio", "video"].includes(String(kind))) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  return Object.freeze([...value]) as readonly PetGatewayAttachmentKind[];
}

function optionalBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isChannelName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32 &&
    /^[a-z0-9][a-z0-9_-]*$/u.test(value)
  );
}
