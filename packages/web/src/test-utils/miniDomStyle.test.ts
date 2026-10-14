import { describe, expect, test } from "bun:test";
import { ensureMiniDom } from "./renderHook";

describe("mini DOM element style", () => {
  test("supports the CSSStyleDeclaration methods React uses for custom properties", () => {
    ensureMiniDom();
    const style = document.createElement("div").style;
    style.setProperty("--radix-popper-available-height", "320px");
    expect(style.getPropertyValue("--radix-popper-available-height")).toBe("320px");
    expect(style.removeProperty("--radix-popper-available-height")).toBe("320px");
    expect(style.getPropertyValue("--radix-popper-available-height")).toBe("");
  });

  test("lets a test substitute its own style method", () => {
    ensureMiniDom();
    const style = document.createElement("div").style;
    const calls: string[] = [];
    style.setProperty = (name: string) => {
      calls.push(name);
    };
    style.setProperty("--x", "1");
    expect(calls).toEqual(["--x"]);
  });

  test("reports an empty layout box for Popper anchors", () => {
    ensureMiniDom();
    const rect = document.createElement("div").getBoundingClientRect();
    expect({ width: rect.width, height: rect.height, top: rect.top, left: rect.left }).toEqual({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
    });
  });

  test("keeps style comparable to a plain object", () => {
    ensureMiniDom();
    const style = document.createElement("div").style as unknown as Record<string, string>;
    style.color = "red";
    expect(style).toEqual({ color: "red" });
  });
});
