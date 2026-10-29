/** Pure input-gate policy shared by the MCP proxy (a separate Node entry) and
 * Desktop main. The proxy enforces it at dispatch time; main owns the state. */

export type InputLane = "read" | "background" | "foreground";
export type InputRefusalReason =
  | "user-stop"
  | "chat-open"
  | "user-active"
  | "session-cancelled"
  | "host-unavailable"
  | "tool-withheld";

export interface InputGateState {
  /** Monotonic; the proxy ignores an older push. */
  version: number;
  /** Every input lane is held until the user explicitly resumes. */
  holdAll?: "user-stop";
  /** Only input that fronts an app or moves the real pointer is held. */
  holdForeground?: "chat-open";
  /** The human is using the keyboard or mouse right now. */
  userActive: boolean;
  /** Sessions whose current run the user cancelled. */
  cancelledSessions: string[];
}

export type InputGateDecision =
  | { allow: true; lane: InputLane }
  | { allow: false; lane: InputLane; reason: InputRefusalReason };

/** Request `_meta` key carrying the calling Session lineage (leaf first). */
export const SESSION_META_KEY = "codeshell/sessionIds";
export const MAX_SESSION_LINEAGE = 8;
export const MAX_CANCELLED_SESSIONS = 64;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

const READ_TOOLS = new Set([
  "get_window_state",
  "get_accessibility_tree",
  "list_apps",
  "list_windows",
  "get_cursor_position",
  "get_screen_size",
  "check_permissions",
  "get_agent_cursor_state",
  "get_desktop_state",
  "get_app_state",
  "zoom",
  "verify_state",
  "get_config",
  "get_recording_state",
  "health_report",
  "check_for_update",
  // Presentation of the agent's own virtual cursor; no user-visible input.
  "start_session",
  "end_session",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_style",
  "stop_recording",
]);

/** Accessibility or per-process delivery that neither fronts an app nor moves
 * the human's pointer, unless the call asks for foreground delivery. */
const BACKGROUND_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "type_text",
  "set_value",
  "select_text",
  "perform_secondary_action",
  "press_key",
  "hotkey",
  "scroll",
  "drag",
  "move_cursor",
  "start_recording",
]);

/** The driver's own browser route: DevTools control of a bound (possibly signed-in)
 * browser, including page scripts. CodeShell's built-in browser tools own web
 * pages, so these are neither listed nor forwarded, whatever the gate state. */
const WITHHELD_TOOLS = new Set(["page", "get_browser_state"]);

export function isWithheldTool(name: string): boolean {
  return name.startsWith("browser_") || WITHHELD_TOOLS.has(name);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Unknown tools are treated as foreground input: fail closed, not open. */
export function inputLane(name: string, args: Record<string, unknown>): InputLane {
  if (READ_TOOLS.has(name)) return "read";
  if (!BACKGROUND_TOOLS.has(name)) return "foreground";
  if (args.delivery_mode === "foreground") return "foreground";
  // Desktop scope drives the real OS pointer rather than a window.
  if (args.scope === "desktop" || object(args.target)?.kind === "desktop") return "foreground";
  return "background";
}

export function gateDecision(
  state: InputGateState | undefined,
  call: { name: string; args: Record<string, unknown>; sessionIds: readonly string[] },
): InputGateDecision {
  const lane = inputLane(call.name, call.args);
  if (isWithheldTool(call.name)) return { allow: false, lane, reason: "tool-withheld" };
  if (lane === "read") return { allow: true, lane };
  if (!state) return { allow: false, lane, reason: "host-unavailable" };
  if (call.sessionIds.some((id) => state.cancelledSessions.includes(id)))
    return { allow: false, lane, reason: "session-cancelled" };
  if (state.holdAll) return { allow: false, lane, reason: state.holdAll };
  if (lane === "foreground") {
    if (state.holdForeground) return { allow: false, lane, reason: state.holdForeground };
    if (state.userActive) return { allow: false, lane, reason: "user-active" };
  }
  return { allow: true, lane };
}

/** True only when no hold of any kind applies (used for uninspectable bytes). */
export function gateFullyOpen(state: InputGateState | undefined): boolean {
  return (
    !!state &&
    !state.holdAll &&
    !state.holdForeground &&
    !state.userActive &&
    state.cancelledSessions.length === 0
  );
}

export function parseSessionLineage(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_SESSION_LINEAGE)
    .filter((id): id is string => typeof id === "string" && SESSION_ID.test(id));
}

export function parseInputGateState(value: unknown): InputGateState | undefined {
  const state = object(value);
  if (!state) return;
  if (typeof state.version !== "number" || !Number.isSafeInteger(state.version)) return;
  if (typeof state.userActive !== "boolean") return;
  if (state.holdAll !== undefined && state.holdAll !== "user-stop") return;
  if (state.holdForeground !== undefined && state.holdForeground !== "chat-open") return;
  if (!Array.isArray(state.cancelledSessions)) return;
  const cancelledSessions = state.cancelledSessions
    .slice(0, MAX_CANCELLED_SESSIONS)
    .filter((id): id is string => typeof id === "string" && SESSION_ID.test(id));
  return {
    version: state.version,
    userActive: state.userActive,
    cancelledSessions,
    ...(state.holdAll ? { holdAll: "user-stop" as const } : {}),
    ...(state.holdForeground ? { holdForeground: "chat-open" as const } : {}),
  };
}

const GUIDANCE: Record<InputRefusalReason, string> = {
  "user-stop":
    "The user stopped computer control. Do not retry this or any other computer input. Stop and tell the user what is left unfinished; only the user can resume control.",
  "chat-open":
    'The user is chatting with Mimi, so input that brings an app forward or moves the real pointer is paused. Do not retry it now. Background accessibility input (without delivery_mode:"foreground") is still allowed; otherwise wait and ask the user.',
  "user-active":
    'The user is using the keyboard or mouse right now. Input that brings an app forward or moves the real pointer is refused so you do not take over their screen. Do not retry immediately. Prefer background accessibility input (without delivery_mode:"foreground"), or ask the user to let you take over.',
  "session-cancelled": "The user cancelled this task. Do not send any further computer input.",
  "host-unavailable":
    "CodeShell cannot confirm the user's control state, so computer input is refused. Do not retry; report the problem to the user.",
  "tool-withheld":
    "CodeShell does not offer the computer-use driver's browser tools. For web pages use CodeShell's built-in browser tools (browser_navigate, browser_observe, browser_act); use computer tools only for desktop apps.",
};

/** A local MCP tool result; the request never reaches the driver. */
export function refusalResponse(
  id: string | number,
  decision: Extract<InputGateDecision, { allow: false }>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text: `computer_input_refused (${decision.reason}). ${GUIDANCE[decision.reason]}`,
        },
      ],
      structuredContent: {
        code: "computer_input_refused",
        reason: decision.reason,
        lane: decision.lane,
      },
    },
  };
}

/** Input strategy appended to the model-facing tool descriptions. */
export const INPUT_POLICY_NOTES: Readonly<Record<string, string>> = {
  set_value:
    "CodeShell policy: prefer this for text fields. Send the whole value at once (Unicode and indentation are preserved), then re-read the field with get_window_state; if it differs, report the difference instead of retrying blindly.",
  type_text:
    "CodeShell policy: use only when set_value is not supported. Background keystrokes into browser or Electron web content are refused (background_unavailable); use set_value there. Send the whole string in one call with delay_ms 0; never loop over characters. Re-read the field afterwards; if it differs, report instead of retrying blindly.",
  press_key:
    "CodeShell policy: for shortcuts and navigation keys only, never to type text character by character.",
  hotkey: "CodeShell policy: for shortcuts only, never to type text.",
  click:
    'CodeShell policy: use background delivery by default. Use delivery_mode:"foreground" only after background_occluded or background_unavailable, and tell the user.',
  drag: 'CodeShell policy: use delivery_mode:"foreground" only after background_unavailable, and tell the user.',
};

export const REFUSAL_POLICY_NOTE =
  "If any computer tool returns computer_input_refused, follow its guidance and do not retry the same action.";
