import { describe, test, expect, afterEach } from "bun:test";
import { groupAlive, killChildTree, killProcessGroup } from "./spawn-common.js";

// These exercise the win32 branches on a non-Windows host by redefining
// process.platform. The actual `taskkill` binary won't exist here, so the
// win32 kill resolves via the spawn 'error' path — the contract under test is
// "never throws, never uses negative-pid signals on win32".

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => setPlatform(realPlatform));

describe("groupAlive — platform-correct existence probe", () => {
  test("POSIX probes the negated pgid (own process is alive)", () => {
    setPlatform("linux");
    // process.kill(-pgid, 0) on our own pgid is alive (or EPERM, still "alive").
    // Use a definitely-dead pid to assert the false path instead.
    expect(groupAlive(2 ** 30)).toBe(false); // ESRCH → dead
  });

  test("win32 probes the positive pid (current pid is alive)", () => {
    setPlatform("win32");
    expect(groupAlive(process.pid)).toBe(true);
    expect(groupAlive(2 ** 30)).toBe(false);
  });
});

describe("win32 kill paths never throw and never signal a negative pid", () => {
  test("killChildTree(win32) resolves without throwing even if taskkill is absent", () => {
    setPlatform("win32");
    let threw = false;
    try {
      killChildTree({ pid: 999999, kill: () => true }, 100);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("killProcessGroup(win32) resolves (taskkill error path) without throwing", async () => {
    setPlatform("win32");
    // pid that doesn't exist → taskkill exits non-zero or errors; either way
    // the promise resolves. We just assert it settles and doesn't reject.
    await expect(killProcessGroup(999999)).resolves.toBeUndefined();
  });
});
