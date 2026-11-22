import { expect, test } from "bun:test";
import { runHostProcessFixture } from "../../../../../tests/helpers/host-process-fixture.js";

test("room authority, pending approvals and process ownership survive a real utility restart", async () => {
  const output = await runHostProcessFixture("hosted-rooms");
  expect(output).toContain("PASS hosted rooms");
}, 40_000);
