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

/**
 * Answer Codex's `request_user_input`: each question is put to the user in
 * turn through `ask`. `current()` is checked before and after every question;
 * once the runtime's authority is gone nothing more is asked or answered.
 */
export async function answerCodexUserInput(
  rawParams: unknown,
  ask: (question: string, options: Record<string, unknown>) => Promise<{ answer?: string }>,
  current: () => boolean,
): Promise<{ answers: Record<string, { answers: string[] }> }> {
  if (!current()) return { answers: {} };
  const params = objectOf(rawParams) ?? {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const answers: Record<string, { answers: string[] }> = {};
  for (const value of questions) {
    if (!current()) return { answers: {} };
    const question = objectOf(value);
    if (!question) continue;
    const id = typeof question.id === "string" ? question.id : "";
    const prompt = typeof question.question === "string" ? question.question : "";
    if (!id || !prompt) continue;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          const item = objectOf(option);
          return item && typeof item.label === "string"
            ? [
                {
                  label: item.label,
                  description: typeof item.description === "string" ? item.description : "",
                },
              ]
            : [];
        })
      : undefined;
    const decision = await ask(prompt, {
      ...(typeof question.header === "string" ? { header: question.header } : {}),
      ...(options && options.length > 0 ? { options } : {}),
    });
    if (current() && decision.answer) answers[id] = { answers: [decision.answer] };
  }
  return { answers };
}
