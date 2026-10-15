import type { MaskedLinkConnection } from "@cjhyy/code-shell-link";
import type { Message } from "../types";

export interface ChatLinkResource {
  providerId: "figma";
  resourceId: string;
  url: string;
}

/** Ephemeral provenance from this window's composer, never reconstructed from transcript text. */
export interface ChatLinkResourceIntent extends ChatLinkResource {
  clientMessageId: string;
  bucket: string;
  cwd: string;
  /** A completed, explicit authorization can resume after the original turn settles. */
  resumeConnection?: MaskedLinkConnection;
}

/** The owner resolves live authority at the instant a user requests a read. */
export type ChatLinkReadHandler = (
  text: string,
  bucket: string,
  clientMessageId: string,
  cwd: string,
) => boolean;

/** The owner's busy predicate includes setBusyForKey's synchronous ref, before React commits. */
export function createChatLinkReadHandler(
  current: () => {
    bucket: string;
    cwd: string | null | undefined;
    available: boolean;
    busy: boolean;
    compacting: boolean;
  },
  send: (
    text: string,
    options: { bucket: string; clientMessageId: string; suppressGoal: true },
  ) => void,
): ChatLinkReadHandler {
  return (text, bucket, clientMessageId, cwd) => {
    const live = current();
    if (
      live.bucket !== bucket ||
      !live.available ||
      live.cwd !== cwd ||
      live.busy ||
      live.compacting
    )
      return false;
    send(text, { bucket, clientMessageId, suppressGoal: true });
    return true;
  };
}

/** Only public HTTPS file links are candidates; recognizing a link grants no authority. */
export function composerLinkResources(text: string): ChatLinkResource[] {
  const files = new Map<string, ChatLinkResource>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const value = match[0].replace(/[),.;!?，。！？）】\]}]+$/, "");
    if (value.length > 1_000 || /[\x00-\x20\x7f]/.test(value)) continue;
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        !["figma.com", "www.figma.com"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        continue;
      const resourceId = /^\/(?:file|design|board)\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(
        url.pathname,
      )?.[1];
      if (!resourceId || files.has(resourceId)) continue;
      files.set(resourceId, { providerId: "figma", resourceId, url: value });
      if (files.size === 3) break;
    } catch {
      // Pasted prose can contain incomplete addresses.
    }
  }
  return [...files.values()];
}

export function figmaFileGranted(
  connection: MaskedLinkConnection | undefined,
  resourceId: string,
): boolean {
  return Boolean(
    connection?.providerId === "figma" &&
    connection.authSource === "remote-link" &&
    connection.status === "connected" &&
    connection.capabilityIds.includes("figma.get_file") &&
    connection.account?.resourceGroups
      ?.find((group) => group.id === "files")
      ?.items.some((item) => item.id === resourceId),
  );
}

/** Start with shallow structure, preserving any node scope in the exact submitted URL. */
export function chatLinkReadArguments(intent: ChatLinkResource, connectionId: string) {
  return {
    provider: intent.providerId,
    action: "get_file",
    connectionId,
    params: { file_url_or_key: intent.url, depth: 2 },
  };
}

/** A tool result can resolve an existing composer intent; it cannot create one. */
export function chatLinkReadOutcome(
  intent: ChatLinkResourceIntent,
  messages: readonly Message[],
): "succeeded" | "failed" | "in-progress" | undefined {
  const submitted = messages.findIndex(
    (message) => message.kind === "user" && message.clientMessageId === intent.clientMessageId,
  );
  if (submitted === -1) return undefined;
  let failed = false;
  let inProgress = false;
  const tools = messages
    .slice(submitted + 1)
    .flatMap((message) =>
      message.kind === "tool" ? [message] : message.kind === "agent" ? message.toolCalls : [],
    );
  for (const message of tools) {
    if (message.toolName !== "LinkAction") continue;
    try {
      const args = JSON.parse(message.args);
      if (
        args.provider !== intent.providerId ||
        !["get_file", "get_nodes", "get_images", "get_image_fills", "get_comments"].includes(
          args.action,
        )
      )
        continue;
      const input = args.params?.file_url_or_key ?? args.params?.file_key;
      const file = typeof input === "string" ? input.trim() : undefined;
      const candidate = file ? composerLinkResources(file)[0] : undefined;
      if (
        typeof file !== "string" ||
        (file !== intent.resourceId &&
          (candidate?.url !== file || candidate.resourceId !== intent.resourceId))
      )
        continue;
      if (message.status === "queued" || message.status === "running") inProgress = true;
      if (["failed", "denied", "cancelled"].includes(message.status)) failed = true;
      if (message.status !== "succeeded" || !message.result) continue;
      const result = JSON.parse(message.result);
      if (
        result.kind === "action_result" &&
        result.provider === intent.providerId &&
        result.action === args.action &&
        Object.prototype.hasOwnProperty.call(result, "data") &&
        result.error === undefined
      )
        return "succeeded";
      if (
        ["error", "connection_required", "cancelled"].includes(result.kind) ||
        result.error !== undefined
      )
        failed = true;
    } catch {
      // Partial streamed arguments and unrecognized results cannot consume an intent.
    }
  }
  return inProgress ? "in-progress" : failed ? "failed" : undefined;
}
