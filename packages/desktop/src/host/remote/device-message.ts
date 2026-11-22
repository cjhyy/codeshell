import type { MobileImageAttachment } from "@cjhyy/code-shell-core";

/** Project the fixed wire fields before a request is copied to another process or socket. */
export function deviceMessageContent(input: {
  text: string;
  attachments?: MobileImageAttachment[];
}) {
  if (typeof input?.text !== "string" || !input.text.trim() || input.text.length > 100_000)
    throw Error("请输入有效任务。");
  if (
    input.attachments !== undefined &&
    (!Array.isArray(input.attachments) || input.attachments.length > 8)
  )
    throw Error("仅支持有界图片附件。");
  let bytes = Buffer.byteLength(input.text);
  const attachments = input.attachments?.map((file) => {
    if (!file || file.transport !== "inline" || typeof file.dataUrl !== "string")
      throw Error("仅支持有界图片附件。");
    for (const label of [file.clientId, file.name, file.mime]) {
      if (label !== undefined && typeof label !== "string") throw Error("仅支持有界图片附件。");
      bytes += label?.length ?? 0;
    }
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0))
      throw Error("仅支持有界图片附件。");
    bytes += file.dataUrl.length;
    if (bytes > 1_048_576) throw Error("任务和图片合计超过 1 MiB，请缩小图片后发送。");
    if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(file.dataUrl))
      throw Error("仅支持有界图片附件。");
    return {
      transport: file.transport,
      dataUrl: file.dataUrl,
      clientId: file.clientId,
      name: file.name,
      mime: file.mime,
      size: file.size,
    };
  });
  const content = { text: input.text, ...(attachments?.length ? { attachments } : {}) };
  if (Buffer.byteLength(JSON.stringify(content)) > 1_048_576)
    throw Error("任务和图片合计超过 1 MiB，请缩小图片后发送。");
  return content;
}
