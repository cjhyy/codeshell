import type { MimiCompanionState } from "../../../shared/mimi-companion";

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
    complete: "任务完成",
    error: "任务没有完成",
  };
  // Name the control category when known; never the control's own text.
  if (state.activity.action === "click" && state.element) {
    const clicks: Partial<Record<NonNullable<MimiCompanionState["element"]>, string>> = {
      text: "点进输入框",
      button: "点按钮",
      link: "打开链接",
      menu: "选菜单",
      list: "选一项",
    };
    return clicks[state.element] ?? labels.click;
  }
  if (state.activity.action === "scroll" && state.element === "list") return "翻看列表";
  return labels[state.activity.action];
}

/** Step back only while computer use is under way and the human takes over
 * (their input pauses the agent's). With no run in progress there is nothing
 * to yield, so ordinary typing never fades the character. */
export function companionYields(state: MimiCompanionState, humanActive: boolean): boolean {
  const running = !["idle", "complete", "error"].includes(state.activity.action);
  return Boolean(state.control?.userActive) && running && !humanActive;
}
