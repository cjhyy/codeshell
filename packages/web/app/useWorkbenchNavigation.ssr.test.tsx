import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useWorkbenchNavigation } from "./useWorkbenchNavigation.js";

test("navigation server rendering needs neither window nor a global location", () => {
  const saved = ["window", "location"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  function Preview() {
    const navigation = useWorkbenchNavigation("owned-ssr");
    return (
      <span>
        {navigation.route.view}:{navigation.route.section ?? "overview"}
      </span>
    );
  }
  try {
    for (const [key] of saved) delete (globalThis as any)[key];
    expect(renderToStaticMarkup(<Preview />)).toBe("<span>chat:overview</span>");
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
