import { expect, test } from "bun:test";
import { join } from "node:path";
import { runHostProcessFixture } from "../../../../../tests/helpers/host-process-fixture.js";

test("hosted IM control, saved setup and outbox survive a real utility restart", async () => {
  const output = await runHostProcessFixture("hosted-im-gateway", (root) => ({
    CODE_SHELL_IM_GATEWAY_CONFIG: join(root, "config.json"),
    CODE_SHELL_DINGTALK_CLIENT_SECRET: "",
  }));
  expect(output).toContain("PASS hosted IM");
}, 40_000);
