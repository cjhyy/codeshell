import { describe, expect, test } from "bun:test";
import { petWidgetMenuLanguage, petWidgetMenuTemplate } from "./pet-widget-menu.js";

function actions(calls: string[]) {
  return {
    open: () => calls.push("open"),
    switchToMoving: () => calls.push("moving"),
    stopOrResumeComputer: (resume: boolean) => calls.push(resume ? "resume" : "stop"),
    close: () => calls.push("close"),
  };
}

describe("docked Mimi native menu", () => {
  test("follows the app locale", () => {
    expect(petWidgetMenuLanguage("zh-CN")).toBe("zh");
    expect(petWidgetMenuLanguage("zh-Hant-TW")).toBe("zh");
    expect(petWidgetMenuLanguage("en-US")).toBe("en");
    expect(petWidgetMenuLanguage("ja")).toBe("en");
  });

  test("lists open, moving, the computer-use gate and close", () => {
    const calls: string[] = [];
    const template = petWidgetMenuTemplate({
      locale: "zh-CN",
      movingAvailable: true,
      computerInput: { resume: false },
      actions: actions(calls),
    });
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "打开 Mimi",
      "切换到移动模式",
      "停止电脑操作（⌘⇧Esc）",
      "separator",
      "关闭 Mimi",
    ]);
    for (const item of template) item.click?.();
    expect(calls).toEqual(["open", "moving", "stop", "close"]);
  });

  test("explains an unavailable moving mode and offers resume when input is held", () => {
    const calls: string[] = [];
    const template = petWidgetMenuTemplate({
      locale: "en-US",
      movingAvailable: false,
      movingUnavailableReason: "driver missing",
      computerInput: { resume: true },
      actions: actions(calls),
    });
    expect(template[1]).toMatchObject({
      label: "Moving mode unavailable: driver missing",
      enabled: false,
    });
    expect(template[2].label).toBe("Resume computer use");
    template[2].click?.();
    expect(calls).toEqual(["resume"]);
    expect(
      petWidgetMenuTemplate({ locale: "en", movingAvailable: true, actions: actions([]) }).map(
        (item) => item.label ?? item.type,
      ),
    ).toEqual(["Open Mimi", "Switch to moving mode", "separator", "Close Mimi"]);
  });
});
