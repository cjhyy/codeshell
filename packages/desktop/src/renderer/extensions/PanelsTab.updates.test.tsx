import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

if (process.env.CODESHELL_PANEL_UPDATES_FIXTURE === "1") {
  await import("./PanelsTab.updates.fixture");
} else {
  test("Panel App update controls pass with the real review dialog", async () => {
    // SSR suites can initialize Radix before the DOM exists, and other renderer
    // suites mock Dialog globally. Keep every real portal assertion isolated.
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, CODESHELL_PANEL_UPDATES_FIXTURE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;
    if (exitCode !== 0) throw new Error(output.trim());
    expect(output).toMatch(/\n\s*0 fail/);
    expect(Number(/\n\s*(\d+) pass/.exec(output)?.[1] ?? 0)).toBeGreaterThan(0);
  }, 20_000);
}
