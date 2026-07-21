import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { DesktopGatewayConfig } from "./config.js";
import {
  DESKTOP_CONTROL_PROTOCOL_VERSION,
  type DesktopControlDescriptor,
  type DesktopControlEvent,
  type DesktopControlEventPage,
  type MobileRemoteOpenResult,
  type MobileRemoteStatus,
  type PetChatRequest,
  type PetChatResult,
} from "./protocol.js";

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore" },
) => ChildProcess;

export interface DesktopControlClientOptions {
  fetch?: typeof fetch;
  spawn?: SpawnFn;
  readDescriptor?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DesktopEventWatchOptions {
  checkpointPath?: string;
  onError?: (error: unknown) => void;
  onRecovered?: () => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface DesktopEventContext {
  streamId: string;
}

interface DesktopEventCheckpoint {
  version: 1;
  streamId: string;
  cursor: number;
}

export class DesktopControlUnavailableError extends Error {
  constructor(message = "桌面端未在线") {
    super(message);
    this.name = "DesktopControlUnavailableError";
  }
}

export class DesktopControlOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopControlOperationError";
  }
}

export class DesktopControlClient {
  private readonly fetchFn: typeof fetch;
  private readonly spawnFn: SpawnFn;
  private readonly readDescriptorFn: () => Promise<string>;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly config: DesktopGatewayConfig,
    opts: DesktopControlClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.spawnFn = opts.spawn ?? spawn;
    this.readDescriptorFn =
      opts.readDescriptor ?? (() => readSecureDescriptor(this.config.descriptorPath));
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async open(): Promise<MobileRemoteOpenResult> {
    await this.ensureDesktopAvailable();
    return this.request<MobileRemoteOpenResult>("POST", "/v1/open", 120_000);
  }

  async close(): Promise<void> {
    await this.request<{ closed: boolean }>("POST", "/v1/close", 15_000);
  }

  status(): Promise<MobileRemoteStatus> {
    return this.request<MobileRemoteStatus>("GET", "/v1/status", 5_000);
  }

  pairingUrl(): Promise<{ pairingUrl: string; expiresAt: number }> {
    return this.request("POST", "/v1/pairing-url", 10_000);
  }

  async petChat(input: PetChatRequest): Promise<PetChatResult> {
    await this.ensureDesktopAvailable();
    return this.request("POST", "/v1/pet/chat", 150_000, input);
  }

  events(after = 0, waitMs = 25_000, signal?: AbortSignal): Promise<DesktopControlEventPage> {
    if (!Number.isSafeInteger(after) || after < 0 || waitMs < 0 || waitMs > 25_000) {
      throw new Error("invalid desktop event cursor");
    }
    return this.request(
      "GET",
      `/v1/events?after=${after}&waitMs=${Math.floor(waitMs)}`,
      waitMs + 5_000,
      undefined,
      signal,
    );
  }

  async watchEvents(
    signal: AbortSignal,
    handle: (event: DesktopControlEvent, context: DesktopEventContext) => Promise<void>,
    options: DesktopEventWatchOptions = {},
  ): Promise<void> {
    const saved = options.checkpointPath
      ? await readEventCheckpoint(options.checkpointPath)
      : undefined;
    let streamId = saved?.streamId;
    let cursor = saved?.cursor ?? 0;
    let retryMs = options.retryBaseMs ?? 1_000;
    const retryMaxMs = options.retryMaxMs ?? 30_000;
    let recovering = false;
    while (!signal.aborted) {
      try {
        const page = await this.events(cursor, 25_000, signal);
        if (streamId !== undefined && streamId !== page.streamId) {
          // Event ids are local to one Desktop process. Reset before reading
          // the replacement stream or a high old cursor could mask new events.
          streamId = page.streamId;
          cursor = 0;
          continue;
        }
        streamId = page.streamId;
        for (const event of page.events) {
          if (signal.aborted) return;
          await handle(event, { streamId });
          cursor = Math.max(cursor, event.id);
          if (options.checkpointPath) {
            await writeEventCheckpoint(options.checkpointPath, { version: 1, streamId, cursor });
          }
        }
        cursor = Math.max(cursor, page.cursor);
        if (recovering) {
          recovering = false;
          options.onRecovered?.();
        }
        retryMs = options.retryBaseMs ?? 1_000;
      } catch (error) {
        if (signal.aborted) return;
        recovering = true;
        options.onError?.(error);
        await Promise.race([this.sleepFn(retryMs), waitForAbort(signal)]);
        retryMs = Math.min(retryMaxMs, retryMs * 2);
      }
    }
  }

  private async ensureDesktopAvailable(): Promise<void> {
    try {
      await this.status();
      return;
    } catch (error) {
      if (!(error instanceof DesktopControlUnavailableError)) throw error;
    }

    if (!this.config.autoLaunch || !this.config.command) {
      throw new DesktopControlUnavailableError("桌面端未在线，且自动唤起已关闭");
    }

    try {
      const child = this.spawnFn(this.config.command, this.config.args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (error) {
      throw new DesktopControlUnavailableError(
        `无法唤起桌面端：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const deadline = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < deadline) {
      await this.sleepFn(500);
      try {
        await this.status();
        return;
      } catch (error) {
        if (!(error instanceof DesktopControlUnavailableError)) throw error;
      }
    }
    throw new DesktopControlUnavailableError("已唤起桌面端，但本地控制面未在超时前就绪");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let descriptor: DesktopControlDescriptor;
    try {
      descriptor = parseDescriptor(await this.readDescriptorFn());
    } catch (error) {
      if (error instanceof DesktopControlUnavailableError) throw error;
      throw new DesktopControlUnavailableError(
        `无法读取桌面端控制信息：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const controller = new AbortController();
    const abortRequest = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortRequest, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(`${descriptor.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new DesktopControlUnavailableError(
        `无法连接桌面端：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortRequest);
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new DesktopControlOperationError(`桌面端返回了无效响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      throw new DesktopControlOperationError(
        typeof body?.message === "string"
          ? body.message
          : `桌面端操作失败（HTTP ${response.status}）`,
      );
    }
    return body as T;
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

export function parseDescriptor(raw: string): DesktopControlDescriptor {
  let parsed: Partial<DesktopControlDescriptor>;
  try {
    parsed = JSON.parse(raw) as Partial<DesktopControlDescriptor>;
  } catch {
    throw new DesktopControlUnavailableError("桌面端控制信息不是有效 JSON");
  }
  if (
    parsed.version !== DESKTOP_CONTROL_PROTOCOL_VERSION ||
    typeof parsed.pid !== "number" ||
    typeof parsed.baseUrl !== "string" ||
    typeof parsed.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.token) ||
    typeof parsed.startedAt !== "number"
  ) {
    throw new DesktopControlUnavailableError("桌面端控制协议版本或字段无效");
  }

  const url = new URL(parsed.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DesktopControlUnavailableError("桌面端控制地址必须是 127.0.0.1 loopback HTTP");
  }
  return parsed as DesktopControlDescriptor;
}

async function readSecureDescriptor(path: string): Promise<string> {
  const [raw, info] = await Promise.all([readFile(path, "utf-8"), stat(path)]);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("桌面端控制信息权限不是 0600");
  }
  return raw;
}

async function readEventCheckpoint(path: string): Promise<DesktopEventCheckpoint | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf-8"), stat(path)]);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`Desktop event checkpoint permissions must be 0600: ${path}`);
    }
    const parsed = JSON.parse(raw) as Partial<DesktopEventCheckpoint>;
    if (
      parsed.version !== 1 ||
      typeof parsed.streamId !== "string" ||
      !/^[a-f0-9]{32}$/.test(parsed.streamId) ||
      !Number.isSafeInteger(parsed.cursor) ||
      (parsed.cursor ?? -1) < 0
    ) {
      throw new Error(`Invalid Desktop event checkpoint: ${path}`);
    }
    return parsed as DesktopEventCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeEventCheckpoint(
  path: string,
  checkpoint: DesktopEventCheckpoint,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
