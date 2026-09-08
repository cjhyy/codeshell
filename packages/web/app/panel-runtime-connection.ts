import { api, ApiError } from "./auth.js";
import { apiUrl, getApiProject } from "./api-context.js";

export interface PanelRuntimeEvent {
  id: number;
  event: string;
  payload: unknown;
}

/** Keep the existing iframe grant alive; no panel state enters this transport. */
export function connectPanelRuntime(options: {
  instanceId: string;
  expiresAt: number;
  workspace: string;
  projectId?: string | null;
  onEvents: (events: PanelRuntimeEvent[]) => void;
  onTerminal: (cause: Error) => void;
  onStatus: (status: string) => void;
}) {
  const projectId = options.projectId === undefined ? getApiProject() : options.projectId;
  const root = `/api/v1/panels/runtime/${encodeURIComponent(options.instanceId)}`;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests = new Set<AbortController>();
  let stopped = false;
  let expiresAt = options.expiresAt;
  let renewAt = expiresAt - 60_000;
  let renewal: Promise<void> | undefined;
  let renewFailures = 0;
  let pollFailures = 0;
  let cursor = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (run: () => void, delay: number) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        if (!stopped) run();
      },
      Math.max(0, Math.min(delay, 2_147_483_647)),
    );
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(timer);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const request of requests) request.abort();
    requests.clear();
  };
  const terminal = (cause: Error) => {
    if (stopped) return;
    stop();
    options.onTerminal(cause);
  };
  const expired = () => terminal(new Error("面板连接已到期，请重新打开继续使用。"));
  const permanent = (cause: unknown) =>
    cause instanceof ApiError && [401, 403, 410].includes(cause.status);
  const status = () => {
    if (!stopped)
      options.onStatus(
        renewFailures || pollFailures ? "面板连接暂时中断，正在重试；当前内容会保留。" : "",
      );
  };
  const request = async (suffix: string, method = "GET") => {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = schedule(() => controller.abort(), 8_000);
    try {
      return await api<unknown>(apiUrl(`${root}${suffix}`, options.workspace, projectId), {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
        signal: controller.signal,
      });
    } finally {
      cancel(timeout);
      requests.delete(controller);
    }
  };
  const armExpiry = () => {
    cancel(expiryTimer);
    expiryTimer = schedule(() => {
      if (Date.now() >= expiresAt) expired();
      else armExpiry();
    }, expiresAt - Date.now());
  };
  const armRenewal = () => {
    cancel(renewTimer);
    if (renewFailures < 5) renewTimer = schedule(refresh, renewAt - Date.now());
  };
  function refresh() {
    if (stopped) return;
    if (Date.now() >= expiresAt) {
      expired();
      return;
    }
    if (renewal || renewFailures >= 5 || Date.now() < renewAt) return;
    renewal = (async () => {
      try {
        const result = await request("/renew", "POST");
        if (stopped) return;
        if (
          !result ||
          typeof result !== "object" ||
          !("expiresAt" in result) ||
          typeof result.expiresAt !== "number" ||
          !Number.isFinite(result.expiresAt) ||
          result.expiresAt <= Date.now() + 60_000
        )
          throw new Error("面板续期响应无效。");
        expiresAt = result.expiresAt;
        renewAt = expiresAt - 60_000;
        renewFailures = 0;
        armExpiry();
        status();
      } catch (cause) {
        if (stopped) return;
        if (permanent(cause)) {
          terminal(cause as ApiError);
          return;
        }
        renewFailures++;
        renewAt = Date.now() + Math.min(5_000 * 2 ** (renewFailures - 1), 30_000);
        status();
      } finally {
        renewal = undefined;
        if (!stopped) armRenewal();
      }
    })();
  }
  async function poll() {
    try {
      const result = await request(`/events?after=${cursor}`);
      if (stopped) return;
      if (!result || typeof result !== "object" || !("cursor" in result) || !("events" in result))
        throw new Error("面板事件响应无效。");
      if (
        !Number.isSafeInteger(result.cursor) ||
        (result.cursor as number) < cursor ||
        !Array.isArray(result.events) ||
        result.events.length > 2048
      )
        throw new Error("面板事件响应无效。");
      const events: PanelRuntimeEvent[] = [];
      let previous = cursor;
      for (const event of result.events) {
        if (
          !event ||
          typeof event !== "object" ||
          !Number.isSafeInteger(event.id) ||
          event.id <= previous ||
          event.id > (result.cursor as number) ||
          typeof event.event !== "string" ||
          !/^[A-Za-z][A-Za-z0-9._-]{0,100}$/.test(event.event)
        )
          throw new Error("面板事件响应无效。");
        previous = event.id;
        events.push(event);
      }
      options.onEvents(events);
      cursor = result.cursor as number;
      pollFailures = 0;
      status();
    } catch (cause) {
      if (stopped) return;
      if (permanent(cause)) {
        terminal(cause as ApiError);
        return;
      }
      pollFailures++;
      status();
    } finally {
      if (!stopped) schedule(() => void poll(), Math.min(1_000 * 2 ** pollFailures, 5_000));
    }
  }
  armExpiry();
  armRenewal();
  void poll();
  return { stop, refresh };
}
