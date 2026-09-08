import type { IncomingMessage, ServerResponse } from "node:http";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager, type SessionState } from "@cjhyy/code-shell-core";
import { replayTranscript, transcriptUserDisplay } from "@cjhyy/code-shell-web";
import { createSessionTitlesStore, SessionTitleConflictError } from "../session-titles-store.js";
import { hubJson } from "./uploads.js";

const ROOT = "/api/v1/sessions";
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

class SessionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeSessionId(sessionId: string): void {
  if (!SAFE_ID.test(sessionId) || sessionId.includes(".."))
    throw new SessionRequestError(400, "会话标识无效。");
}

function boundedSessionFile(
  rootDir: string,
  sessionId: string,
  filename: string,
  limit: number,
): string {
  safeSessionId(sessionId);
  let directory: number | undefined;
  let descriptor: number | undefined;
  try {
    const root = realpathSync(rootDir);
    const path = join(root, sessionId);
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new SessionRequestError(403, "会话存储位置无效。");
    directory = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
    );
    const openedDirectory = fstatSync(directory);
    if (openedDirectory.dev !== info.dev || openedDirectory.ino !== info.ino)
      throw new SessionRequestError(409, "会话存储正在变化，请重试。");
    descriptor = openSync(
      process.platform === "linux"
        ? `/proc/self/fd/${directory}/${filename}`
        : join(path, filename),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const file = fstatSync(descriptor);
    if (!file.isFile()) throw new SessionRequestError(403, "会话记录不是普通文件。");
    if (file.size > limit)
      throw new SessionRequestError(
        413,
        filename === "transcript.jsonl"
          ? "对话记录超过浏览器可读取的 32 MB 上限，请从服务器会话备份中获取完整记录。"
          : "会话状态记录过大，无法在浏览器读取。",
      );
    // Snapshot exactly the checked prefix. An append during a running turn can
    // be picked up by the live overlay without growing this allocation.
    const buffer = Buffer.alloc(file.size);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    const currentDirectory = lstatSync(path);
    const currentFile = lstatSync(join(path, filename));
    if (
      currentDirectory.isSymbolicLink() ||
      currentFile.isSymbolicLink() ||
      currentDirectory.dev !== info.dev ||
      currentDirectory.ino !== info.ino ||
      currentFile.dev !== file.dev ||
      currentFile.ino !== file.ino
    )
      throw new SessionRequestError(409, "会话存储正在变化，请重试。");
    return buffer.subarray(0, bytes).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new SessionRequestError(404, "会话记录不存在或已移动。");
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw new SessionRequestError(403, "不能读取符号链接中的会话记录。");
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directory !== undefined) closeSync(directory);
  }
}

/** Synchronous, side-effect-free transcript snapshot used by HTTP exports and WS replay. */
export function readHubTranscript(sessionRootDir: string, sessionId: string): unknown[] {
  const raw = boundedSessionFile(sessionRootDir, sessionId, "transcript.jsonl", MAX_EXPORT_BYTES);
  const lines = raw.split("\n");
  const events: unknown[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as { type?: unknown }).type !== "string"
      )
        throw new Error();
      events.push(value);
    } catch {
      // The worker may be appending the current event; only a final unterminated
      // fragment can be omitted. Invalid interior records must never disappear silently.
      if (index === lines.length - 1 && !raw.endsWith("\n")) break;
      throw new SessionRequestError(422, "对话记录包含损坏内容，请从服务器备份检查完整记录。");
    }
  }
  return events;
}

/** Host authorization reads only bounded metadata, never a transcript or mutable engine bundle. */
export function readHubSessionState(sessionRootDir: string, sessionId: string): SessionState {
  const raw = boundedSessionFile(sessionRootDir, sessionId, "state.json", MAX_STATE_BYTES);
  try {
    const value = JSON.parse(raw) as SessionState;
    if (!value || value.sessionId !== sessionId || typeof value.cwd !== "string") throw new Error();
    return value;
  } catch {
    throw new SessionRequestError(422, "会话状态包含损坏内容，请从服务器备份检查记录。");
  }
}

export function createHubSessions(options: {
  cwd: string;
  sessionRootDir: string;
  dataDir: string;
  isAuthorized: (req: IncomingMessage) => Promise<boolean>;
  isRunning: (sessionId: string) => boolean;
  onChanged: (sessionId: string) => void;
}) {
  const manager = new SessionManager(options.sessionRootDir);
  const titles = createSessionTitlesStore(join(options.dataDir, "session-titles.json"), {
    strictMutations: true,
  });
  const cwd = resolve(options.cwd);
  let activeExports = 0;

  function owned(sessionId: string): SessionState {
    safeSessionId(sessionId);
    try {
      // Reading state alone avoids loading a large transcript for a rename.
      const state = readHubSessionState(options.sessionRootDir, sessionId);
      if (
        !state ||
        state.sessionId !== sessionId ||
        typeof state.cwd !== "string" ||
        resolve(state.cwd) !== cwd ||
        state.parentSessionId ||
        state.ephemeral
      )
        throw new Error();
      return state;
    } catch {
      throw new SessionRequestError(404, "当前工作区没有这个会话。");
    }
  }

  function summary(
    state: SessionState & { preview?: string; lastActiveAt?: number },
    customTitle = "",
  ) {
    return {
      sessionId: state.sessionId,
      cwd: state.cwd,
      title:
        customTitle ||
        hubSessionPreview(state.title) ||
        hubSessionPreview(state.preview) ||
        "新对话",
      customTitle,
      startedAt: state.startedAt,
      lastActiveAt: state.lastActiveAt ?? state.startedAt,
      model: state.model,
      status: state.status,
      turnCount: state.turnCount,
      archivedAt: state.archivedAt ?? null,
      running: options.isRunning(state.sessionId),
      ...(state.preview ? { preview: hubSessionPreview(state.preview) } : {}),
    };
  }

  async function list(params: URLSearchParams = new URLSearchParams()) {
    const archived = params.get("archived") ?? "false";
    if (!["false", "true", "all"].includes(archived))
      throw new SessionRequestError(400, "归档筛选无效。");
    const query = (params.get("query") ?? "").trim();
    if (query.length > 200) throw new SessionRequestError(400, "搜索内容过长。");
    const limit = Number(params.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new SessionRequestError(400, "每页数量必须在 1 到 100 之间。");
    let before: { lastActiveAt: number; sessionId: string } | undefined;
    const cursor = params.get("cursor");
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Number.isFinite(parsed.lastActiveAt) || !SAFE_ID.test(parsed.sessionId))
          throw new Error();
        before = { lastActiveAt: parsed.lastActiveAt, sessionId: parsed.sessionId };
      } catch {
        throw new SessionRequestError(400, "分页位置无效，请刷新会话列表。");
      }
    }
    const customTitles = await titles.listTitles();
    const search = query.toLocaleLowerCase();
    const entries = manager.list(limit + 1, {
      cwd,
      rootsOnly: true,
      ...(archived !== "all" ? { archived: archived === "true" } : {}),
      ...(before ? { before } : {}),
      filter: search
        ? (state) =>
            `${customTitles[state.sessionId] ?? ""}\n${hubSessionPreview(state.title) ?? ""}\n${hubSessionPreview(state.preview) ?? ""}\n${state.sessionId}`
              .toLocaleLowerCase()
              .includes(search)
        : undefined,
    });
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      sessions: page.map((state) => summary(state, customTitles[state.sessionId])),
      nextCursor:
        entries.length > limit && last
          ? Buffer.from(
              JSON.stringify({ lastActiveAt: last.lastActiveAt, sessionId: last.sessionId }),
            ).toString("base64url")
          : null,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
    let exporting = false;
    try {
      if (!(await options.isAuthorized(req))) throw new SessionRequestError(401, "请重新登录。");
      if (url.pathname === ROOT && req.method === "GET") {
        const result = await list(url.searchParams);
        if (!(await options.isAuthorized(req))) throw new SessionRequestError(401, "请重新登录。");
        hubJson(res, 200, result);
        return true;
      }
      const match = /^\/api\/v1\/sessions\/([^/]+)(\/export)?$/.exec(url.pathname);
      if (!match) throw new SessionRequestError(404, "没有这个会话操作。");
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match[1]!);
      } catch {
        throw new SessionRequestError(400, "会话标识无效。");
      }
      const state = owned(sessionId);
      if (!match[2] && req.method === "GET") {
        const customTitles = await titles.listTitles();
        if (!(await options.isAuthorized(req))) throw new SessionRequestError(401, "请重新登录。");
        hubJson(res, 200, summary(owned(sessionId), customTitles[sessionId]));
      } else if (match[2] && req.method === "GET") {
        if (options.isRunning(sessionId))
          throw new SessionRequestError(409, "请等待当前任务完成后再导出完整对话。");
        if (activeExports >= 2)
          throw new SessionRequestError(429, "正在导出的对话过多，请稍后重试。");
        activeExports++;
        exporting = true;
        const transcript = readHubTranscript(options.sessionRootDir, sessionId);
        const format = url.searchParams.get("format") ?? "markdown";
        if (format !== "json" && format !== "markdown")
          throw new SessionRequestError(400, "不支持这个导出格式。");
        const title =
          (await titles.listTitles())[sessionId] ||
          hubSessionPreview(state.title) ||
          "CodeShell 对话";
        const body =
          format === "json"
            ? JSON.stringify({ version: 1, title, state, transcript }, null, 2) + "\n"
            : transcriptMarkdown(title, transcript);
        if (Buffer.byteLength(body) > MAX_EXPORT_BYTES)
          throw new SessionRequestError(413, "导出内容过大。");
        if (!(await options.isAuthorized(req))) throw new SessionRequestError(401, "请重新登录。");
        res.writeHead(200, {
          "content-type":
            format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="codeshell-${sessionId}.${format === "json" ? "json" : "md"}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(body);
      } else if (!match[2] && req.method === "PATCH") {
        const input = await readBody(req);
        if (!(await options.isAuthorized(req))) throw new SessionRequestError(401, "请重新登录。");
        owned(sessionId);
        if ("title" in input) {
          if (Object.keys(input).some((key) => key !== "title" && key !== "expectedTitle"))
            throw new SessionRequestError(400, "每次只修改一个会话属性。");
          if (
            typeof input.title !== "string" ||
            input.title.length > 1024 ||
            /[\0\r\n]/.test(input.title)
          )
            throw new SessionRequestError(400, "标题必须是 1024 字以内的单行文字。");
          if (
            input.expectedTitle !== undefined &&
            input.expectedTitle !== null &&
            (typeof input.expectedTitle !== "string" ||
              input.expectedTitle.length > 1024 ||
              input.expectedTitle.includes("\0"))
          )
            throw new SessionRequestError(400, "用于比较的原标题无效，请重新读取会话。");
          await titles.setTitle(sessionId, input.title.trim(), {
            expectedTitle: input.expectedTitle as string | null | undefined,
          });
        } else if (Object.keys(input).length === 1 && typeof input.archived === "boolean") {
          if (options.isRunning(sessionId))
            throw new SessionRequestError(409, "请等待当前任务完成后再归档或恢复会话。");
          manager.setSessionArchived(sessionId, input.archived ? Date.now() : undefined);
        } else throw new SessionRequestError(400, "不支持这个会话属性。");
        options.onChanged(sessionId);
        hubJson(res, 200, { ok: true });
      } else throw new SessionRequestError(405, "不支持这个请求方式。");
    } catch (cause) {
      hubJson(
        res,
        cause instanceof SessionTitleConflictError
          ? 409
          : cause instanceof SessionRequestError
            ? cause.status
            : 500,
        {
          error:
            cause instanceof SessionTitleConflictError
              ? "另一设备已修改标题。你的草稿已保留，请读取最新标题后再确认保存。"
              : cause instanceof SessionRequestError
                ? cause.message
                : "会话操作失败，原有记录仍保留在服务器。",
        },
      );
    } finally {
      if (exporting) activeExports--;
    }
    return true;
  }
  return { handle, list };
}

function fenced(content: string, language = ""): string {
  let longest = 2;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}

/** Keep engine attachment wrappers out of title/search/preview surfaces. */
export function hubSessionPreview(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // Core bounds optional preview text. A clipped attachment block is metadata,
  // even when its closing tag fell outside that bound; never expose its paths.
  const source = value.replace(
    /<attached-(file|directory|image-paths)\b[^>]*>(?:(?!<\/attached-\1>)[\s\S])*$/g,
    "",
  );
  const display = transcriptUserDisplay({ content: source });
  return (
    (
      display.text ||
      display.attachments.map((file) => `📎 ${file.name}`).join(" · ") ||
      (source !== value ? "📎 附件" : "")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240) || undefined
  );
}

export function transcriptMarkdown(title: string, transcript: readonly unknown[]): string {
  const sections = [`# ${title.replace(/[\r\n]/g, " ")}`];
  for (const item of replayTranscript(transcript).items) {
    if (item.kind === "user") {
      sections.push(`## 用户\n\n${item.text}`);
      if (item.attachments?.length)
        sections.push(
          item.attachments.map((file) => `- 附件：${file.name}（${file.size} 字节）`).join("\n"),
        );
    } else if (item.kind === "assistant") {
      sections.push(`## ${item.agentId ? `子代理 ${item.agentId}` : "助手"}\n\n${item.text}`);
      if (item.reasoning) sections.push(`### 推理\n\n${item.reasoning}`);
    } else if (item.kind === "tool") {
      sections.push(
        `### 工具：${item.name}\n\n${fenced(JSON.stringify(item.args ?? {}, null, 2), "json")}`,
      );
      if (item.result) sections.push(fenced(item.result));
    } else if (item.kind === "system_error") sections.push(`### 错误\n\n${item.text}`);
    else sections.push(`### 子代理：${item.label}\n\n${item.status}`);
  }
  return sections.join("\n\n") + "\n";
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
    throw new SessionRequestError(415, "请求必须使用 JSON 格式。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => req.destroy(), 10_000);
  timer.unref();
  try {
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 8192) throw new SessionRequestError(413, "请求内容过大。");
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new SessionRequestError(400, "请求不是有效的 JSON 对象。");
  }
}
