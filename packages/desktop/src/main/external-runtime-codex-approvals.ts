import type { CodexFileChangeSummary } from "@cjhyy/code-shell-capability-coding/external-runtimes";

/**
 * What a Codex native approval asks, as the approval card (desktop, phone)
 * and Mimi's IM prompt read it: a description and readable args.
 *
 * Codex answers through `item/<kind>/requestApproval` with protocol params
 * (`codex app-server generate-ts`, codex-cli 0.162.0): routing ids, a reason,
 * and per kind the command and its cwd, a network host, or a permission
 * profile. A file change names no files itself; the runtime attaches the
 * files its `fileChange` item announced (`fileChanges`, the first 50 of
 * `fileChangeCount`). Only methods that
 * contain `requestApproval` reach here (`CodexRuntime.onServerRequest`).
 */
export function codexNativeApprovalPresentation(
  method: string,
  params: unknown,
  fileChanges?: readonly CodexFileChangeSummary[],
  fileChangeCount?: number,
): { description: string; args: Record<string, unknown> } {
  const record = objectOf(params) ?? {};
  const reason = text(record.reason);
  const cwd = text(record.cwd);
  if (method === "item/commandExecution/requestApproval") {
    const command = text(record.command);
    const network = objectOf(record.networkApprovalContext);
    const host = text(network?.host);
    const protocol = text(network?.protocol);
    // Input typed into a terminal that is already running, not a new command.
    const stdin = record.kind === "writeStdin";
    return {
      description: host
        ? `Codex 想访问网络：${host}${protocol ? `（${protocol}）` : ""}`
        : stdin
          ? "Codex 想向正在运行的终端输入"
          : "Codex 想执行命令",
      args: {
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(host ? { network: { host, ...(protocol ? { protocol } : {}) } } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const grantRoot = text(record.grantRoot);
    const files = fileChanges?.map((change) =>
      change.movePath
        ? `${change.kind} ${change.path} → ${change.movePath}`
        : `${change.kind} ${change.path}`,
    );
    // Only the first files are listed: say how many more there are.
    const more = files ? Math.max(0, (fileChangeCount ?? files.length) - files.length) : 0;
    if (files && more > 0) files.push(`…还有 ${more} 个文件`);
    return {
      description:
        files && files.length > 0
          ? more > 0
            ? `Codex 想修改 ${fileChangeCount} 个文件（只列出前 ${files.length - 1} 个，完整改动请在桌面查看）`
            : "Codex 想修改文件"
          : "Codex 想修改文件（打开桌面查看改动）",
      args: {
        ...(files && files.length > 0 ? { files } : {}),
        ...(grantRoot ? { grantRoot } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = objectOf(record.permissions);
    const network = objectOf(permissions?.network);
    const fileSystem = objectOf(permissions?.fileSystem);
    return {
      description: "Codex 想获得额外权限（仅本轮）",
      args: {
        ...(network ? { network } : {}),
        ...(fileSystem ? { fileSystem } : {}),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }
  return {
    description: `Codex 请求批准（${method}）`,
    args: Object.fromEntries(
      Object.entries(record).filter(([key]) => !CODEX_ROUTING_KEYS.has(key)),
    ),
  };
}

/** Codex routing ids and timestamps: noise to the owner, never shown. */
const CODEX_ROUTING_KEYS = new Set([
  "threadId",
  "turnId",
  "itemId",
  "approvalId",
  "environmentId",
  "startedAtMs",
]);

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
