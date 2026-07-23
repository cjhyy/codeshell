import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GatewayControlEventAttachment } from "../im-gateway-control-server.js";
import type { PetHostActionExecution } from "./pet-dispatch-service.js";

const MAX_KEPT_QR_FILES = 4;

const HOST_ACTION_LABELS: Record<string, string> = {
  mobileRemote: "手机遥控",
  longTaskControl: "长程任务",
  memory: "记忆",
  gatewayReply: "Gateway 回复",
};

const LONG_TASK_ACTION_LABELS: Record<string, string> = {
  pause: "已暂停",
  resume: "已继续",
  retry: "已开始重试",
  cancel: "已取消",
};

const MEMORY_ACTION_LABELS: Record<string, string> = {
  remember: "已记住这条信息。",
  update: "记忆已更新。",
  forget: "已删除这条记忆。",
};

export interface HostActionReplyEnrichment {
  text: string;
  button?: { text: string; url: string };
  attachments: GatewayControlEventAttachment[];
}

/**
 * Fold host-executed action outcomes into Mimi's IM reply. Mimi's own text can
 * only promise ("我去打开隧道"); the honest result — real tunnel address,
 * pairing QR, task state change, memory confirmation, or the error — is
 * appended here by the host after execution.
 */
export async function enrichPetChatReplyWithHostActions(
  baseText: string,
  executions: readonly PetHostActionExecution[] | undefined,
  options: {
    qrDir: string;
    attachmentKinds?: readonly ("image" | "file" | "audio" | "video")[];
  },
): Promise<HostActionReplyEnrichment> {
  if (!executions?.length) return { text: baseText.trim(), attachments: [] };

  const attachmentKinds = options.attachmentKinds ?? ["image", "file", "audio", "video"];
  const lines: string[] = [];
  const attachments: GatewayControlEventAttachment[] = [];
  let gatewayReplyText: string | undefined;
  let gatewayReplyButton: { text: string; url: string } | undefined;
  let gatewayReplyFailed = false;
  for (const execution of executions) {
    if (!execution.ok) {
      if (execution.kind === "gatewayReply") gatewayReplyFailed = true;
      const label = HOST_ACTION_LABELS[execution.kind] ?? execution.kind;
      lines.push(
        execution.kind === "gatewayReply"
          ? `Gateway 回复未发送：${execution.error ?? "未知错误"}`
          : `${label}操作失败：${execution.error ?? "未知错误"}`,
      );
      continue;
    }
    if (execution.kind === "mobileRemote") {
      const rendered = await renderMobileRemoteLines(
        execution,
        options.qrDir,
        attachmentKinds.includes("image"),
      );
      lines.push(...rendered.lines);
      attachments.push(...rendered.attachments);
    } else if (execution.kind === "longTaskControl") {
      lines.push(renderLongTaskLine(execution));
    } else if (execution.kind === "memory") {
      lines.push(renderMemoryLine(execution));
    } else if (execution.kind === "gatewayReply") {
      const rendered = renderGatewayReply(execution, attachmentKinds);
      if (!rendered) {
        gatewayReplyFailed = true;
        lines.push("Gateway 回复未发送：宿主返回了无效结果。");
      } else {
        gatewayReplyText = rendered.text;
        gatewayReplyButton = rendered.button;
        attachments.push(...rendered.attachments);
      }
    }
  }

  const appended = lines.join("\n");
  // The model only sees that its request was recorded; actual file validation
  // runs after its turn. If validation fails, discard any premature "sent"
  // claim and return the authoritative host failure instead.
  const trimmed = gatewayReplyFailed ? "" : (gatewayReplyText ?? baseText.trim());
  return {
    text: appended ? (trimmed ? `${trimmed}\n\n${appended}` : appended) : trimmed,
    ...(!gatewayReplyFailed && gatewayReplyButton ? { button: gatewayReplyButton } : {}),
    attachments,
  };
}

function renderGatewayReply(
  execution: PetHostActionExecution,
  supportedKinds: readonly ("image" | "file" | "audio" | "video")[],
):
  | {
      text: string;
      button?: { text: string; url: string };
      attachments: GatewayControlEventAttachment[];
    }
  | undefined {
  const text = typeof execution.result?.text === "string" ? execution.result.text.trim() : "";
  if (!text) return undefined;
  const rawButton = execution.result?.button;
  const button =
    rawButton && typeof rawButton === "object" && !Array.isArray(rawButton)
      ? (rawButton as Record<string, unknown>)
      : undefined;
  if (
    button &&
    (typeof button.text !== "string" ||
      !button.text.trim() ||
      typeof button.url !== "string" ||
      !button.url.trim())
  ) {
    return undefined;
  }
  const candidates = execution.result?.attachments;
  const attachments = (Array.isArray(candidates) ? candidates : []).filter(
    (candidate): candidate is GatewayControlEventAttachment =>
      Boolean(candidate) &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      ["image", "file", "audio", "video"].includes(
        String((candidate as { kind?: unknown }).kind),
      ) &&
      typeof (candidate as { path?: unknown }).path === "string" &&
      typeof (candidate as { name?: unknown }).name === "string" &&
      typeof (candidate as { mimeType?: unknown }).mimeType === "string" &&
      typeof (candidate as { size?: unknown }).size === "number" &&
      Number.isSafeInteger((candidate as { size: number }).size) &&
      supportedKinds.includes((candidate as { kind: "image" | "file" | "audio" | "video" }).kind),
  );
  if (Array.isArray(execution.payload.attachmentPaths) && attachments.length === 0)
    return undefined;
  return {
    text,
    ...(button ? { button: { text: String(button.text), url: String(button.url) } } : {}),
    attachments,
  };
}

async function renderMobileRemoteLines(
  execution: PetHostActionExecution,
  qrDir: string,
  renderQr: boolean,
): Promise<{ lines: string[]; attachments: GatewayControlEventAttachment[] }> {
  if (execution.payload.action === "close") {
    return { lines: ["公网隧道已关闭。"], attachments: [] };
  }
  const url = typeof execution.result?.url === "string" ? execution.result.url : "地址未知";
  const pairingUrl =
    typeof execution.result?.pairingUrl === "string" ? execution.result.pairingUrl : undefined;
  const lines = [
    `公网隧道已开启：${url}`,
    ...(pairingUrl ? [`配对入口（10 分钟内有效）：${pairingUrl}`] : []),
  ];
  const attachments: GatewayControlEventAttachment[] = [];
  if (pairingUrl && renderQr) {
    const qr = await renderPairingQrFile(pairingUrl, qrDir);
    if (qr) {
      attachments.push(qr);
      lines.push("也可以直接扫描下方二维码。");
    }
  }
  lines.push("打开后仍需输入桌面端已设置的访问口令。");
  return { lines, attachments };
}

function renderLongTaskLine(execution: PetHostActionExecution): string {
  const action = String(execution.payload.action ?? "");
  const verb = LONG_TASK_ACTION_LABELS[action] ?? `已执行 ${action}`;
  const objective =
    typeof execution.result?.objective === "string"
      ? execution.result.objective.replace(/\s+/gu, " ").trim().slice(0, 120)
      : "";
  return objective ? `任务「${objective}」${verb}。` : `任务${verb}。`;
}

function renderMemoryLine(execution: PetHostActionExecution): string {
  const action = String(execution.payload.action ?? "");
  if (action === "remember" && execution.result?.unchanged === true) {
    return "已有等价的用户记忆，已保留原文。";
  }
  return MEMORY_ACTION_LABELS[action] ?? "记忆已更新。";
}

/** Render the one-time pairing URL as a PNG QR file; best-effort. */
async function renderPairingQrFile(
  pairingUrl: string,
  qrDir: string,
): Promise<GatewayControlEventAttachment | undefined> {
  try {
    const { default: QRCode } = await import("qrcode");
    const data = await QRCode.toBuffer(pairingUrl, { type: "png", width: 512, margin: 2 });
    await mkdir(qrDir, { recursive: true, mode: 0o700 });
    const path = join(qrDir, `pairing-qr-${Date.now()}-${randomUUID()}.png`);
    await writeFile(path, data, { mode: 0o600 });
    await pruneOldQrFiles(qrDir);
    const info = await stat(path);
    return {
      kind: "image",
      name: "pairing-qr.png",
      mimeType: "image/png",
      size: info.size,
      path,
    };
  } catch {
    return undefined;
  }
}

/** Pairing tokens expire in minutes; only the newest few QR files are worth keeping. */
async function pruneOldQrFiles(qrDir: string): Promise<void> {
  try {
    const files = (await readdir(qrDir)).filter(
      (name) => name.startsWith("pairing-qr-") && name.endsWith(".png"),
    );
    // Names embed a millisecond timestamp, so lexicographic order is creation order.
    const stale = files.sort().slice(0, Math.max(0, files.length - MAX_KEPT_QR_FILES));
    await Promise.all(stale.map((name) => rm(join(qrDir, name), { force: true })));
  } catch {
    // Cleanup is best-effort; a stale QR file is harmless.
  }
}
