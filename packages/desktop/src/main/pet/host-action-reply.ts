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
  options: { qrDir: string },
): Promise<HostActionReplyEnrichment> {
  if (!executions?.length) return { text: baseText.trim(), attachments: [] };

  const lines: string[] = [];
  const attachments: GatewayControlEventAttachment[] = [];
  for (const execution of executions) {
    if (!execution.ok) {
      const label = HOST_ACTION_LABELS[execution.kind] ?? execution.kind;
      lines.push(`${label}操作失败：${execution.error ?? "未知错误"}`);
      continue;
    }
    if (execution.kind === "mobileRemote") {
      const rendered = await renderMobileRemoteLines(execution, options.qrDir);
      lines.push(...rendered.lines);
      attachments.push(...rendered.attachments);
    } else if (execution.kind === "longTaskControl") {
      lines.push(renderLongTaskLine(execution));
    } else if (execution.kind === "memory") {
      lines.push(renderMemoryLine(execution));    }
  }

  const appended = lines.join("\n");
  const trimmed = baseText.trim();
  return {
    text: appended ? (trimmed ? `${trimmed}\n\n${appended}` : appended) : trimmed,
    attachments,
  };
}

async function renderMobileRemoteLines(
  execution: PetHostActionExecution,
  qrDir: string,
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
  if (pairingUrl) {
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
