export const PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX = "pet-host-action-";
export const PET_HOST_ACTION_REPLACE_CLIENT_ID_PREFIX = "pet-host-action-replace-";
export const PET_HOST_ACTION_REPLACE_DELIVERY_CLIENT_ID_PREFIX =
  "pet-host-action-replace-delivery-";
export const PET_HOST_ACTION_REPLACE_DISPLAY_MARKER = "<!--PET:HOST_ACTION_REPLACE-->";
const PET_HOST_ACTION_REPLACE_DISPLAY_PREFIX = "<!--PET:HOST_ACTION_REPLACE:";

export interface PetHostActionReplacementDisplayMetadata {
  sourceClientMessageId: string;
  deliveryChannel?: string;
}

/** Recover display-only replacement metadata from a durable receipt id. */
export function replacementReceiptDisplayMetadata(
  receiptClientMessageId: unknown,
  text: string,
): PetHostActionReplacementDisplayMetadata | undefined {
  if (typeof receiptClientMessageId !== "string") return undefined;
  if (receiptClientMessageId.startsWith(PET_HOST_ACTION_REPLACE_DELIVERY_CLIENT_ID_PREFIX)) {
    const encoded = receiptClientMessageId.slice(
      PET_HOST_ACTION_REPLACE_DELIVERY_CLIENT_ID_PREFIX.length,
    );
    const separator = encoded.indexOf(":");
    if (separator <= 0 || separator === encoded.length - 1) return undefined;
    try {
      const deliveryChannel = decodeURIComponent(encoded.slice(0, separator));
      const sourceClientMessageId = encoded.slice(separator + 1);
      if (!deliveryChannel || !sourceClientMessageId) return undefined;
      return { sourceClientMessageId, deliveryChannel };
    } catch {
      return undefined;
    }
  }
  if (receiptClientMessageId.startsWith(PET_HOST_ACTION_REPLACE_CLIENT_ID_PREFIX)) {
    const sourceClientMessageId = receiptClientMessageId.slice(
      PET_HOST_ACTION_REPLACE_CLIENT_ID_PREFIX.length,
    );
    return sourceClientMessageId ? { sourceClientMessageId } : undefined;
  }
  if (
    receiptClientMessageId.startsWith(PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX) &&
    /(?:^|\n)(?:主动消息操作失败：[^\n]*|消息已发送(?:到 [^\n。]+)?。|(?:消息|消息和 \d+ 个附件)已提交(?:到 [^\n，。]+)?，(?:平台已接受发送请求。|平台接口已接受发送请求；尚未确认收件设备已展示。))(?:$|\n)/u.test(
      text,
    )
  ) {
    const sourceClientMessageId = receiptClientMessageId.slice(
      PET_HOST_ACTION_RECEIPT_CLIENT_ID_PREFIX.length,
    );
    return sourceClientMessageId ? { sourceClientMessageId } : undefined;
  }
  return undefined;
}

/** Recognize both new structured receipts and already-persisted outbound receipts. */
export function replacementReceiptSourceClientMessageId(
  receiptClientMessageId: unknown,
  text: string,
): string | undefined {
  return replacementReceiptDisplayMetadata(receiptClientMessageId, text)?.sourceClientMessageId;
}

export function markPetHostActionReplacementDisplay(
  text: string,
  sourceClientMessageId?: string,
  deliveryChannel?: string,
): string {
  const marker = sourceClientMessageId
    ? `${PET_HOST_ACTION_REPLACE_DISPLAY_PREFIX}${encodeURIComponent(sourceClientMessageId)}${
        deliveryChannel ? `:${encodeURIComponent(deliveryChannel)}` : ""
      }-->`
    : PET_HOST_ACTION_REPLACE_DISPLAY_MARKER;
  return `${marker}${text}`;
}

export function parsePetHostActionReplacementDisplay(text: string): {
  replacesAssistant: boolean;
  sourceClientMessageId?: string;
  deliveryChannel?: string;
  text: string;
} {
  if (text.startsWith(PET_HOST_ACTION_REPLACE_DISPLAY_MARKER)) {
    return {
      replacesAssistant: true,
      text: text.slice(PET_HOST_ACTION_REPLACE_DISPLAY_MARKER.length).trim(),
    };
  }
  if (!text.startsWith(PET_HOST_ACTION_REPLACE_DISPLAY_PREFIX)) {
    return { replacesAssistant: false, text };
  }
  const markerEnd = text.indexOf("-->", PET_HOST_ACTION_REPLACE_DISPLAY_PREFIX.length);
  if (markerEnd < 0) return { replacesAssistant: false, text };
  const encodedMetadata = text.slice(PET_HOST_ACTION_REPLACE_DISPLAY_PREFIX.length, markerEnd);
  const separator = encodedMetadata.indexOf(":");
  const encodedSource = separator < 0 ? encodedMetadata : encodedMetadata.slice(0, separator);
  const encodedChannel = separator < 0 ? undefined : encodedMetadata.slice(separator + 1);
  try {
    const sourceClientMessageId = decodeURIComponent(encodedSource);
    if (!sourceClientMessageId) return { replacesAssistant: false, text };
    const deliveryChannel = encodedChannel ? decodeURIComponent(encodedChannel) : undefined;
    return {
      replacesAssistant: true,
      sourceClientMessageId,
      ...(deliveryChannel ? { deliveryChannel } : {}),
      text: text.slice(markerEnd + 3).trim(),
    };
  } catch {
    return { replacesAssistant: false, text };
  }
}
