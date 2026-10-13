import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { runCandidateHttpFixture } from "./fixtures/docker-candidate-http-runner.mjs";

test("actual guarded Node HTTP preserves cookies/binary/ranges/compression and closes refusals", async () => {
  const result = await runCandidateHttpFixture(realpathSync(Bun.which("node")!), "native");
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  const value = JSON.parse(result.stdout.trim());
  expect(value).toMatchObject({
    passed: true,
    preCore6plus4: true,
    native: true,
    cookie: true,
    binary: true,
    ranges: true,
    compression: true,
    redirectsBlocked: true,
    sseBlocked: true,
    capacityBlocked: true,
    deadlineBlocked: true,
    revokedBeforeSend: true,
    stoppedInflight: true,
    listenerClosed: true,
    sockets: 0,
  });
  expect(value.httpDeadline).toBe(150000);
  expect(value.bodyLimit).toBe(64 * 1024 * 1024);
}, 20000);
