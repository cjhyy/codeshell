/** Content-free, advisory projection of the pinned Cua Driver 0.34.1 MCP surface.
 * Input authority and all coordinate validation remain in the driver. */
export type CuaActivityAction =
  | "observe"
  | "click"
  | "type"
  | "scroll"
  | "drag"
  | "key"
  | "working"
  | "error";

export interface CuaActivityEvent {
  id: string;
  action: CuaActivityAction;
  phase: "start" | "end";
  target?: { x: number; y: number };
  capture: boolean;
  failed?: boolean;
}

type RecordValue = Record<string, unknown>;
interface Geometry {
  pid?: number;
  windowId?: number;
  at: number;
  bounds?: { x: number; y: number; width: number; height: number };
  imageWidth?: number;
  imageHeight?: number;
  captureId?: string;
  tokens: Map<string, { x: number; y: number }>;
}

interface Pending {
  event: CuaActivityEvent;
  name: string;
  pid?: number;
  windowId?: number;
  displayOnly: boolean;
}

const MAX_WINDOWS = 16;
const MAX_TOKENS_PER_WINDOW = 2_000;
const MAX_PENDING = 256;
const GEOMETRY_TTL_MS = 15_000;
const TOKEN_PATTERN = /^s[0-9a-f]{8}:[0-9]+$/;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function rpcId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 512) return `s:${value}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
  return undefined;
}

function windowIdentity(args: RecordValue): { pid?: number; windowId?: number } {
  const target = record(args.target);
  if (target?.kind === "window") {
    return { pid: integer(target.pid), windowId: integer(target.window_id) };
  }
  return { pid: integer(args.pid), windowId: integer(args.window_id) };
}

function classify(name: string, args: RecordValue): Pick<CuaActivityEvent, "action" | "capture"> {
  switch (name) {
    case "click":
    case "double_click":
    case "right_click":
      return { action: "click", capture: typeof args.debug_image_out === "string" };
    case "type_text":
    case "set_value":
      return { action: "type", capture: false };
    case "scroll":
      return { action: "scroll", capture: false };
    case "drag":
      return { action: "drag", capture: false };
    case "press_key":
    case "hotkey":
      return { action: "key", capture: false };
    case "get_window_state":
      return {
        action: "observe",
        capture: args.include_screenshot !== false || typeof args.screenshot_out_file === "string",
      };
    case "get_accessibility_tree":
    case "list_apps":
    case "list_windows":
    case "get_cursor_position":
    case "get_screen_size":
    case "check_permissions":
    case "get_agent_cursor_state":
      return { action: "observe", capture: false };
    case "get_desktop_state":
    case "get_browser_state":
    case "zoom":
    case "verify_state":
      return { action: "observe", capture: true };
    default:
      // Browser actions, scripts, batches, recording and future tools may capture
      // internally. Keep our overlay hidden for the entire opaque invocation.
      return { action: "working", capture: true };
  }
}

/** Stores only bounded geometry and request identities, never text or image data. */
export class CuaActivityTracker {
  private readonly windows = new Map<string, Geometry>();
  private desktop?: Geometry;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;

  constructor(
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
  ) {}

  begin(message: unknown): CuaActivityEvent | undefined {
    const request = record(message);
    const params = record(request?.params);
    const key = rpcId(request?.id);
    if (request?.method !== "tools/call" || !key || typeof params?.name !== "string") return;
    if (this.pending.has(key) || this.pending.size >= MAX_PENDING) return;
    const args = record(params.arguments) ?? {};
    const name = params.name;
    const identity = windowIdentity(args);
    const classified = classify(name, args);
    const target = classified.capture ? undefined : this.target(args, name);
    const event: CuaActivityEvent = {
      id: `${this.prefix}:${++this.sequence}`,
      ...classified,
      phase: "start",
      ...(target ? { target } : {}),
    };
    this.pending.set(key, {
      event,
      name,
      ...identity,
      displayOnly: args.display_only === true,
    });
    return event;
  }

  finish(message: unknown): CuaActivityEvent | undefined {
    const response = record(message);
    if (!response || !("result" in response || "error" in response)) return;
    const key = rpcId(response.id);
    const pending = key ? this.pending.get(key) : undefined;
    if (!key || !pending) return;
    this.pending.delete(key);
    const result = record(response.result);
    const failed = response.error !== undefined || result?.isError === true;
    if (!failed) this.observe(pending, record(result?.structuredContent));
    if (
      failed ||
      (pending.event.action !== "observe" && pending.name !== "get_agent_cursor_state")
    ) {
      // A mutation can move a window or invalidate an element's placement. Require
      // another observed snapshot rather than inventing a path from old geometry.
      this.windows.clear();
      this.desktop = undefined;
    }
    return {
      id: pending.event.id,
      action: pending.event.action,
      phase: "end",
      capture: pending.event.capture,
      ...(failed ? { failed: true } : {}),
    };
  }

  clear(): CuaActivityEvent[] {
    const events = [...this.pending.values()].map(({ event }) => ({
      id: event.id,
      action: event.action,
      phase: "end" as const,
      capture: event.capture,
      failed: true,
    }));
    this.pending.clear();
    this.windows.clear();
    this.desktop = undefined;
    return events;
  }

  private fresh(geometry: Geometry | undefined): geometry is Geometry {
    return (
      !!geometry && this.now() - geometry.at >= 0 && this.now() - geometry.at <= GEOMETRY_TTL_MS
    );
  }

  private target(args: RecordValue, name: string): CuaActivityEvent["target"] {
    if (args.from_zoom === true) return;
    const explicit = record(args.target);
    const identity = windowIdentity(args);
    const desktop = explicit?.kind === "desktop" || args.scope === "desktop";
    if (desktop && explicit?.display_id !== undefined && explicit.display_id !== "primary") return;
    let geometry: Geometry | undefined;
    if (desktop) geometry = this.desktop;
    else if (identity.pid !== undefined && identity.windowId !== undefined) {
      geometry = this.windows.get(`${identity.pid}:${identity.windowId}`);
    }
    if (typeof args.element_token === "string") {
      if (!TOKEN_PATTERN.test(args.element_token) || desktop) return;
      for (const item of geometry ? [geometry] : this.windows.values()) {
        if (!this.fresh(item) || (identity.pid !== undefined && item.pid !== identity.pid))
          continue;
        if (identity.windowId !== undefined && item.windowId !== identity.windowId) continue;
        const point = item.tokens.get(args.element_token);
        if (point) return { ...point };
      }
      return;
    }
    const x = name === "drag" ? args.from_x : args.x;
    const y = name === "drag" ? args.from_y : args.y;
    if (!this.fresh(geometry) || !geometry.bounds || !finite(x) || !finite(y)) return;
    if (typeof args.capture_id === "string" && args.capture_id !== geometry.captureId) return;
    if (!positive(geometry.imageWidth) || !positive(geometry.imageHeight)) return;
    if (x < 0 || y < 0 || x >= geometry.imageWidth || y >= geometry.imageHeight) return;
    return {
      x: geometry.bounds.x + (x * geometry.bounds.width) / geometry.imageWidth,
      y: geometry.bounds.y + (y * geometry.bounds.height) / geometry.imageHeight,
    };
  }

  private observe(pending: Pending, value: RecordValue | undefined): void {
    if (!value || pending.displayOnly) return;
    if (pending.name === "get_desktop_state") {
      this.desktop = undefined;
      if (value.platform !== "macos" || value.display !== "primary") return;
      if (!positive(value.screen_width) || !positive(value.screen_height)) return;
      if (!positive(value.screenshot_width) || !positive(value.screenshot_height)) return;
      this.desktop = {
        at: this.now(),
        bounds: { x: 0, y: 0, width: value.screen_width, height: value.screen_height },
        imageWidth: value.screenshot_width,
        imageHeight: value.screenshot_height,
        captureId:
          typeof value.capture_id === "string" ? value.capture_id.slice(0, 256) : undefined,
        tokens: new Map(),
      };
      return;
    }
    if (pending.name !== "get_window_state") return;
    const { pid, windowId } = pending;
    if (pid === undefined || windowId === undefined) return;
    const key = `${pid}:${windowId}`;
    this.windows.delete(key);
    if (value.pid !== pid || value.window_id !== windowId) return;
    const geometry: Geometry = { pid, windowId, at: this.now(), tokens: new Map() };
    const bounds = record(value.window_bounds);
    if (
      value.screenshot_frame_valid === true &&
      bounds &&
      finite(bounds.x) &&
      finite(bounds.y) &&
      positive(bounds.width) &&
      positive(bounds.height) &&
      positive(value.screenshot_width) &&
      positive(value.screenshot_height)
    ) {
      geometry.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      geometry.imageWidth = value.screenshot_width;
      geometry.imageHeight = value.screenshot_height;
      geometry.captureId =
        typeof value.capture_id === "string" ? value.capture_id.slice(0, 256) : undefined;
    }
    // macOS AX frame is global screen points. screenshot_frame (when present)
    // is a different, window-local pixel frame and must never be substituted.
    for (const raw of Array.isArray(value.elements)
      ? value.elements.slice(0, MAX_TOKENS_PER_WINDOW)
      : []) {
      const element = record(raw);
      const frame = record(element?.frame);
      if (typeof element?.element_token !== "string" || !TOKEN_PATTERN.test(element.element_token))
        continue;
      if (
        !frame ||
        !finite(frame.x) ||
        !finite(frame.y) ||
        !positive(frame.w) ||
        !positive(frame.h)
      )
        continue;
      geometry.tokens.set(element.element_token, {
        x: frame.x + frame.w / 2,
        y: frame.y + frame.h / 2,
      });
    }
    this.windows.set(key, geometry);
    while (this.windows.size > MAX_WINDOWS) this.windows.delete(this.windows.keys().next().value!);
  }
}
