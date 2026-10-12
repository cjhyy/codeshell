import { redactSecrets } from "./redact-secrets.js";

export interface BackgroundNotificationPayload {
  workId: string;
  workKind: string;
  status: "completed" | "failed" | "cancelled";
  name?: unknown;
  command?: unknown;
  error?: unknown;
  exitCode?: unknown;
  signal?: unknown;
}

const WORK_LABELS = new Map([
  ["shell", "后台命令"],
  ["agent", "后台任务"],
  ["video", "视频任务"],
  ["cc", "外部代理任务"],
]);

function bounded(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

function safeText(value: string, limit: number): string {
  const quotedSecretsRedacted = value.replace(
    /\b([A-Za-z0-9_]*(?:token|secret|api[_-]?key|password|passwd|credential|authorization|bearer)[A-Za-z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*')/gi,
    "$1[REDACTED]",
  );
  const redacted = String(redactSecrets({ text: quotedSecretsRedacted })?.text ?? "")
    // A command/error may use a separate flag value rather than key=value.
    .replace(
      /(--?[A-Za-z0-9_-]*(?:token|secret|api[_-]?key|password|passwd|credential|authorization|bearer)[A-Za-z0-9_-]*\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return bounded(redacted, limit);
}

// Only use the executable and a recognized script/subcommand as an identity.
// Showing an arbitrary command prefix can expose positional passwords, headers,
// URL credentials, or environment values in a notification on the lock screen.
function commandWords(command: string, skippedDirectories = 0): string[] | undefined {
  const firstLine = command.split(/[\r\n]/u, 1)[0]!;
  if (firstLine.length > 4_096) return undefined;
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < firstLine.length; index += 1) {
    const character = firstLine[index]!;
    if (!quote && /[;|&<>]/u.test(character)) {
      const prefix = word ? [...words, word] : words;
      const simpleDirectoryChange =
        (prefix.length === 2 && prefix[0] === "cd") ||
        (prefix.length === 3 && prefix[0] === "cd" && prefix[1] === "--");
      // `cd path && executable ...` is a common launch wrapper. Skip only
      // that literal form, without expanding or evaluating the directory.
      if (
        simpleDirectoryChange &&
        firstLine.slice(index, index + 2) === "&&" &&
        skippedDirectories < 4
      ) {
        return commandWords(firstLine.slice(index + 2), skippedDirectories + 1);
      }
      break;
    }
    if (character === "\\" && quote !== "'") {
      const next = firstLine[++index];
      if (next === undefined) return undefined;
      word += next;
    } else if (character === quote) {
      quote = undefined;
    } else if (!quote && (character === "'" || character === '"')) {
      quote = character;
    } else if (!quote && /\s/u.test(character)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += character;
    }
  }
  if (quote) return undefined;
  if (word) words.push(word);
  return words;
}

function safeFilename(value: string): string | undefined {
  const name = value.split(/[\\/]/u).pop()!;
  return /^[\p{L}\p{N}_.+-]+$/u.test(name) ? name : undefined;
}

function commandIdentity(command: string): string | undefined {
  const words = commandWords(command);
  if (!words) return undefined;
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!)) words.shift();
  if (words[0] === "env" || words[0] === "nohup") {
    words.shift();
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0]!)) words.shift();
  }
  const executable = words[0] && safeFilename(words[0]);
  if (!executable) return undefined;
  let identity = executable;
  const argument = words[1];
  if (
    /^(?:node|bun|deno|python(?:\d+(?:\.\d+)?)?|ruby|perl)$/u.test(executable) &&
    argument &&
    /\.(?:[cm]?js|tsx?|py|rb|pl)$/iu.test(argument)
  ) {
    const script = safeFilename(argument);
    if (script) identity += ` ${script}`;
  } else if (
    /^(?:bun|npm|pnpm|yarn)$/u.test(executable) &&
    argument === "run" &&
    words[2] &&
    /^[A-Za-z0-9_.:-]+$/u.test(words[2])
  ) {
    identity += ` run ${words[2]}`;
  }
  return safeText(identity, 64);
}

export function backgroundNotificationContent(payload: BackgroundNotificationPayload): {
  title: string;
  body: string;
} {
  const label = WORK_LABELS.get(payload.workKind) ?? "后台任务";
  const command = typeof payload.command === "string" ? payload.command : undefined;
  const name = typeof payload.name === "string" ? safeText(payload.name, 64) : undefined;
  const identity =
    (payload.workKind === "shell" && command ? commandIdentity(command) : undefined) ||
    name ||
    `${label} ${safeText(payload.workId, 40)}`;
  const signal =
    typeof payload.signal === "string" && /^SIG[A-Z0-9]{1,29}$/u.test(payload.signal)
      ? payload.signal
      : undefined;
  const terminated = payload.status === "failed" && !!signal;
  const status =
    payload.status === "completed"
      ? "完成"
      : payload.status === "cancelled"
        ? "已取消"
        : terminated
          ? "已终止"
          : "失败";
  const details: string[] = [];
  if (payload.status === "failed") {
    if (signal) details.push(`收到 ${signal} 信号，进程已终止`);
    else if (Number.isSafeInteger(payload.exitCode)) details.push(`退出码 ${payload.exitCode}`);
    if (
      typeof payload.error === "string" &&
      // This legacy shell error repeats the cause and an agent-only tool call.
      !/^Background shell \S+ exited with (?:signal|exit) .+\. Use BashOutput\(/u.test(
        payload.error,
      )
    ) {
      const error = safeText(
        command ? payload.error.replaceAll(command, identity) : payload.error,
        100,
      );
      if (error) details.push(error);
    }
    if (!details.length) details.push("执行失败，点击查看详情");
  } else {
    details.push(payload.status === "completed" ? "点击查看结果" : "任务已取消");
  }
  return { title: `${label}${status}`, body: bounded([identity, ...details].join(" · "), 180) };
}
