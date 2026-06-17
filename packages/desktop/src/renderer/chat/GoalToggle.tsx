import React from "react";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();
  return (
    <Button
      type="button"
      variant={enabled ? "default" : "outline"}
      size="sm"
      className={cn("h-7 shrink-0 gap-1.5 px-2 text-xs", enabled && "shadow-sm")}
      disabled={disabled}
      aria-pressed={enabled}
      aria-label={enabled ? t("chat.goal.on") : t("chat.goal.off")}
      title={enabled ? t("chat.goal.onTitle") : t("chat.goal.offTitle")}
      onClick={() => onToggle(!enabled)}
    >
      <Target size={12} className="shrink-0" aria-hidden="true" />
      <span className="@max-[520px]/composer-controls:hidden">Goal</span>
    </Button>
  );
}
