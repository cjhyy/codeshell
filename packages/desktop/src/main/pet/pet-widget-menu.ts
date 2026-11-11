/**
 * The docked Mimi's native context menu. Main has no UI dictionary, so the
 * menu's few strings live here, chosen by the app locale.
 */

export type PetWidgetMenuLanguage = "zh" | "en";

const STRINGS = {
  zh: {
    open: "打开 Mimi",
    moving: "切换到移动模式",
    movingUnavailable: (reason: string) =>
      reason ? `移动模式不可用：${reason}` : "移动模式不可用",
    resumeComputer: "继续电脑操作",
    stopComputer: "停止电脑操作（⌘⇧Esc）",
    close: "关闭 Mimi",
  },
  en: {
    open: "Open Mimi",
    moving: "Switch to moving mode",
    movingUnavailable: (reason: string) =>
      reason ? `Moving mode unavailable: ${reason}` : "Moving mode unavailable",
    resumeComputer: "Resume computer use",
    stopComputer: "Stop computer use (⌘⇧Esc)",
    close: "Close Mimi",
  },
} as const;

export function petWidgetMenuLanguage(locale: string): PetWidgetMenuLanguage {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** The subset of Electron's MenuItemConstructorOptions this menu uses. */
export interface PetWidgetMenuItem {
  type?: "separator";
  label?: string;
  enabled?: boolean;
  click?: () => void;
}

export function petWidgetMenuTemplate({
  locale,
  movingAvailable,
  movingUnavailableReason,
  computerInput,
  actions,
}: {
  locale: string;
  movingAvailable: boolean;
  movingUnavailableReason?: string;
  /** Present when the computer-use execution gate exists; `resume` when it is held. */
  computerInput?: { resume: boolean };
  actions: {
    open(): void;
    switchToMoving(): void;
    stopOrResumeComputer(resume: boolean): void;
    close(): void;
  };
}): PetWidgetMenuItem[] {
  const text = STRINGS[petWidgetMenuLanguage(locale)];
  const template: PetWidgetMenuItem[] = [
    { label: text.open, click: actions.open },
    {
      label: movingAvailable ? text.moving : text.movingUnavailable(movingUnavailableReason ?? ""),
      enabled: movingAvailable,
      click: actions.switchToMoving,
    },
  ];
  // Docked keeps the stop/resume entry the moving character offers. These are
  // requests to the execution gate; switching forms never changes the gate.
  if (computerInput) {
    const { resume } = computerInput;
    template.push({
      label: resume ? text.resumeComputer : text.stopComputer,
      click: () => actions.stopOrResumeComputer(resume),
    });
  }
  template.push({ type: "separator" }, { label: text.close, click: actions.close });
  return template;
}
