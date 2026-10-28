import type { MimiCompanionState } from "../../../shared/mimi-companion";

export interface CompanionPose {
  gazeX: number;
  gazeY: number;
  reach: number;
  handPulse: number;
  bodyLean: number;
  concerned: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Small, authored parameter gestures; these do not claim to be an IK hand contact. */
export function companionPose(
  state: MimiCompanionState,
  elapsedMs: number,
  reducedMotion = false,
): CompanionPose {
  const center = {
    x: state.position.x + state.size * 0.35,
    y: state.position.y + state.size * 0.3,
  };
  const gazeX = state.target ? clamp((state.target.x - center.x) / state.size, -1, 1) : 0;
  const gazeY = state.target ? clamp((center.y - state.target.y) / state.size, -1, 1) : 0;
  const action = state.activity.action;
  // The host emits idle after its short completion dwell, so fast clicks remain legible.
  const active = action !== "idle";
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const pulse = reducedMotion ? 0 : (1 - Math.cos(elapsed / 180)) / 2;
  const click = active && action === "click";
  const typing = active && action === "type";
  const dragging = active && action === "drag";
  const scrolling = active && action === "scroll";
  return {
    gazeX,
    gazeY,
    reach: reducedMotion ? 0 : dragging ? 0.55 : click ? 0.45 : scrolling ? 0.3 : 0,
    handPulse: typing ? 0.12 * pulse : click ? 0.12 * pulse : scrolling ? 0.16 * pulse : 0,
    bodyLean: reducedMotion ? 0 : typing || dragging ? 3 : active ? 1 : 0,
    concerned: action === "error" ? 0.6 : 0,
  };
}

export function companionActionLabel(state: MimiCompanionState): string {
  const labels: Record<MimiCompanionState["activity"]["action"], string> = {
    idle: "等待下一步",
    observe: "观察界面",
    click: "点击",
    type: "输入",
    scroll: "滚动",
    drag: "拖动",
    key: "按键",
    working: "操作中",
    error: "操作遇到问题",
  };
  return labels[state.activity.action];
}
