import assert from "node:assert/strict";

// Shared by the full theme smoke and the native Wayland session.
export async function checkDockedPetWindow(app, win, inspectNative) {
  await win.evaluate(() => window.codeshell.pet.setWidgetVisible(true));
  try {
    const isDocked = (page) => {
      const { searchParams } = new URL(page.url());
      return searchParams.get("popout") === "pet" && !searchParams.has("role");
    };
    const pet =
      app.windows().find(isDocked) ?? (await app.waitForEvent("window", { predicate: isDocked }));
    await pet.waitForFunction(() =>
      document.documentElement.classList.contains("pet-widget-window"),
    );
    const metrics = await pet.evaluate(() => ({
      backgrounds: [document.documentElement, document.body, document.getElementById("root")].map(
        (node) => getComputedStyle(node).backgroundColor,
      ),
      wallpaper: getComputedStyle(document.body, "::before").backgroundImage,
      surfaces: document.querySelectorAll("[data-theme-surface]").length,
    }));
    assert(
      metrics.backgrounds.every((color) => color === "rgba(0, 0, 0, 0)"),
      "Pet window keeps transparent roots",
    );
    assert(
      metrics.wallpaper === "none" && metrics.surfaces === 0,
      "Pet window receives no surface wallpaper or frame",
    );
    assert.equal(
      await win.evaluate(async () => (await window.codeshell.pet.getPresence()).shown),
      "docked",
    );
    if (inspectNative) {
      const handle = await app.browserWindow(pet);
      try {
        await inspectNative(handle);
      } finally {
        await handle.dispose();
      }
    }
    return metrics;
  } finally {
    await win.evaluate(() => window.codeshell.pet.setWidgetVisible(false));
  }
}
