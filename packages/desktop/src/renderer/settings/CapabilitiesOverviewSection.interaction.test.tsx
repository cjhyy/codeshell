import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

if (process.env.CODESHELL_CAPABILITY_DETAILS_FIXTURE === "1") {
  await import("./CapabilitiesOverviewSection.interaction.fixture");
} else {
  test("project capability details use the selected project's Panel version", async () => {
    // Settings caches and shared renderer mocks must not leak across suites.
    // The guarded shard's isolated HOME and credential-free env are inherited.
    const child = Bun.spawn([process.execPath, "test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, CODESHELL_CAPABILITY_DETAILS_FIXTURE: "1" },
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
