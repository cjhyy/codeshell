import type { StreamEvent, TranscriptEvent } from "../types.js";
import { byteLengthFromBase64 } from "../utils/base64.js";
import { attachmentReferenceDisplay, splitAttachmentReferences } from "./attachment-references.js";

type UserEvent = Extract<StreamEvent, { type: "session_user_message" }>;
type DisplayContent = NonNullable<UserEvent["transcriptMessage"]>["content"];
type DisplayBlock = Exclude<DisplayContent, string>[number];

/** Preserve canonical input display/origin without duplicating image payloads. */
export function outputUserMessage(
  message: TranscriptEvent["data"],
  sessionId: string,
  cwd: string,
): UserEvent {
  const authority = message.authority;
  const hidden =
    message.injected === true ||
    authority === "agent" ||
    authority === "system" ||
    authority === "policy";
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.flatMap<DisplayBlock>((block) =>
            block.type === "text" && typeof block.text === "string"
              ? [{ type: "text" as const, text: block.text }]
              : block.type === "image" && typeof block.source?.media_type === "string"
                ? [
                    {
                      type: "image" as const,
                      source: {
                        media_type: block.source.media_type,
                        byteLength: byteLengthFromBase64(
                          typeof block.source.data === "string" ? block.source.data : "",
                        ),
                      },
                    },
                  ]
                : [],
          )
        : "";
  const projection = Array.isArray(content) || content.includes("<attached-");
  // External runtimes persist the path block the CLI reads; show what was typed
  // and surface the paths as attachments instead.
  const referenced =
    hidden || projection ? undefined : splitAttachmentReferences(content as string);
  const references = referenced?.references.length ? referenced.references : undefined;
  return {
    type: "session_user_message",
    sessionId,
    text:
      hidden || projection
        ? ""
        : typeof message.displayText === "string"
          ? message.displayText
          : references
            ? referenced!.text
            : content,
    ...(typeof message.clientMessageId === "string"
      ? { clientMessageId: message.clientMessageId }
      : {}),
    ...(hidden ? { injected: true } : {}),
    ...(authority === "user" ||
    authority === "agent" ||
    authority === "system" ||
    authority === "policy"
      ? { authority }
      : {}),
    ...(references ? { attachments: references.map(attachmentReferenceDisplay) } : {}),
    ...(!hidden && projection
      ? {
          transcriptMessage: {
            cwd,
            content,
            ...(typeof message.displayText === "string"
              ? { displayText: message.displayText }
              : {}),
          },
        }
      : {}),
  };
}
