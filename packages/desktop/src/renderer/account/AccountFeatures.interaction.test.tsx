import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
for (const entry of ["devices", "phone", "cloud", "remote"])
  for (const state of ["hidden", "sign-in", "pending", "ready"])
    test(`${entry} follows the Host feature state ${state}`, () => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          fileURLToPath(new URL("./AccountFeatures.interaction.fixture.tsx", import.meta.url)),
          entry,
          state,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({
        code: 0,
        error: "",
      });
    });
for (const scenario of [
  "late-snapshot",
  "late-failure",
  "unmount",
  "cloud-default",
  "cloud-revoke-cleanup",
  "cloud-sign-in-transition",
])
  test(`account feature lifecycle: ${scenario}`, () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./AccountFeatures.interaction.fixture.tsx", import.meta.url)),
        scenario,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({
      code: 0,
      error: "",
    });
  });
