import React from "react";
import { Target } from "lucide-react";

/**
 * Goal 模式开关 — orthogonal to the permission pill.
 *
 * When on, the current send's prompt is treated as a goal: the engine runs
 * loop-until-done (a GoalStopHook re-prompts until the session model judges
 * the goal met, bounded by a block cap). Enabling it does NOT change the
 * permission level by itself — App defaults the permission pill to 完全访问
 * on enable as a convenience, but the user can still dial it back. That
 * coupling lives in App, not here; this component is a pure toggle.
 */
interface Props {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}

export function GoalToggle({ enabled, onToggle, disabled }: Props) {
  return (
    <button
      type="button"
      className={`composer-pill goal-toggle${enabled ? " goal-toggle-on" : ""}`}
      disabled={disabled}
      aria-pressed={enabled}
      title={
        enabled
          ? "Goal 模式:把这条消息当目标,跑到完成为止(危险操作仍按权限处理)"
          : "Goal 模式(关):点亮后设目标,agent 跑到完成为止"
      }
      onClick={() => onToggle(!enabled)}
    >
      <Target size={12} />
      {/* Narrow composer (panel open): icon-only, hide the label. Keyed to the
          composer card's @container width. */}
      <span className="@max-[480px]:hidden">Goal</span>
    </button>
  );
}
