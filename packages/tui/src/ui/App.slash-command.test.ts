import { describe, expect, test } from "bun:test";
import { dispatchSlashCommandSafely } from "./App.js";
import type { CommandContext } from "../cli/commands/registry.js";

describe("dispatchSlashCommandSafely", () => {
  test("reports async command failures as status text", async () => {
    const statuses: string[] = [];
    const registry = {
      dispatch: () => Promise.reject(new Error("boom")),
    };

    dispatchSlashCommandSafely(
      registry,
      "/explode",
      {} as CommandContext,
      (status) => statuses.push(status),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(statuses).toEqual(["Command failed: boom"]);
  });
});
