import { describe, expect, test } from "bun:test";
import type {
  MobileClientEvent,
  MobileServerEvent,
  OutputHistoryRecoveryPlan,
} from "@cjhyy/code-shell-core";
import { MobileHistoryRecoveryRequests } from "./mobileHistoryRecoveryRequests.js";
const result: OutputHistoryRecoveryPlan = {
  status: "blocked",
  sessionId: "one",
  reason: "history_mismatch",
};
function fixture(timeoutMs = 50) {
  const identity = { sessionId: "one", revision: 1, generation: 1, online: true };
  const sent: MobileClientEvent[] = [];
  let send = true;
  const requests = new MobileHistoryRecoveryRequests({
    current: () => identity,
    send: (event) => {
      sent.push(event);
      return send;
    },
    timeoutMs,
  });
  const reply = (): MobileServerEvent => ({ ...sent.at(-1), result }) as MobileServerEvent;
  return {
    identity,
    sent,
    requests,
    reply,
    failSend: () => {
      send = false;
    },
  };
}
describe("mobile explicit history recovery requests", () => {
  test("correlates exact operation and session without automatic replay", async () => {
    const f = fixture();
    const promise = f.requests.plan("one");
    expect(f.sent).toHaveLength(1);
    f.requests.observe({ ...f.reply(), requestId: "older" } as MobileServerEvent);
    f.requests.observe(f.reply());
    expect(await promise).toEqual(result);
    expect(f.sent).toHaveLength(1);
  });
  for (const key of ["sessionId", "revision", "generation", "online"] as const)
    test(`rejects stale ${key} instead of binding a reply`, async () => {
      const f = fixture();
      const promise = f.requests.plan("one").catch((error) => error);
      Object.assign(f.identity, {
        [key]: key === "sessionId" ? "two" : key === "online" ? false : 2,
      });
      f.requests.observe(f.reply());
      expect(await promise).toBeInstanceOf(Error);
      expect(f.sent).toHaveLength(1);
    });
  test("send failure, timeout and cancellation settle explicitly", async () => {
    const f = fixture(5);
    f.failSend();
    await expect(f.requests.plan("one")).rejects.toThrow("not sent");
    const timed = fixture(5);
    await expect(timed.requests.plan("one")).rejects.toThrow("expired");
    const cancelled = fixture();
    const promise = cancelled.requests
      .apply("one", { planId: "review", acceptHistoricalGap: true })
      .catch((error) => error);
    cancelled.requests.cancel();
    expect(await promise).toBeInstanceOf(Error);
    expect(cancelled.sent).toEqual([
      {
        type: "session.outputRecovery.apply",
        sessionId: "one",
        requestId: "history-review-1",
        planId: "review",
        acceptHistoricalGap: true,
      },
    ]);
  });
});
