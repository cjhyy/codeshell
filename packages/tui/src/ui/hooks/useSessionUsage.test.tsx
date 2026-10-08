import { expect, test } from "bun:test";
import React, { useRef, useState } from "react";
import { Text } from "../../render/index.js";
import type { AgentClient, UsageSummary } from "@cjhyy/code-shell-core";
import { formatUsageCost } from "@cjhyy/code-shell-core";
import { flush, mount, plainText } from "../../../../../tests/render-fixtures.js";
import { useSessionUsage } from "./useSessionUsage.js";

async function rendered() {
  await flush();
  // The real terminal renderer coalesces updates within its frame interval.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await flush();
}

function fixture() {
  const queries: {
    sid: string;
    resolve: (value: { data: UsageSummary }) => void;
    reject: (error: Error) => void;
  }[] = [];
  const client = {
    query: (_type: string, args: { sessionId: string }) =>
      new Promise((resolve, reject) => {
        queries.push({ sid: args.sessionId, resolve: resolve as never, reject });
      }),
  } as unknown as AgentClient;
  let select: (sid: string) => void;
  let refresh: (sid: string | undefined) => Promise<void>;
  function Harness() {
    const [sid, setSid] = useState("A");
    select = setSid;
    const current = useRef<string | undefined>(sid);
    current.current = sid;
    const usage = useSessionUsage(client, sid, current);
    refresh = usage.refresh;
    return <Text>{usage.summary ? formatUsageCost(usage.summary) : "unavailable"}</Text>;
  }
  const harness = mount(<Harness />);
  const settle = (index: number, amount: number) =>
    queries[index]!.resolve({
      data: {
        version: 1,
        scope: "session",
        sessionId: queries[index]!.sid,
        includesChildren: true,
        knownEstimatedCostUsd: amount,
        unknownCostRequests: 0,
        partial: false,
        totalTokens: 100,
      } as UsageSummary,
    });
  return {
    harness,
    queries,
    settle,
    select: (sid: string) => select(sid),
    refresh: () => refresh("A"),
  };
}

test("terminal Session usage hydrates on resume and rejects another Session's delayed bill", async () => {
  const f = fixture();
  try {
    await rendered();
    f.settle(0, 10);
    await rendered();
    expect(plainText(f.harness)).toContain("10.000000");
    f.harness.frames.length = 0;
    const old = f.refresh();
    f.select("B");
    await rendered();
    expect(plainText(f.harness)).not.toContain("10.000000");
    expect(f.queries.at(-1)!.sid).toBe("B");
    f.settle(1, 99);
    await old;
    await rendered();
    expect(plainText(f.harness)).not.toContain("99.000000");
    f.settle(2, 2);
    await rendered();
    expect(plainText(f.harness)).toContain("2.000000");
  } finally {
    f.harness.unmount();
  }
});

test("newer same-Session evidence wins; failed latest read clears prior cost", async () => {
  const f = fixture();
  try {
    await rendered();
    const newest = f.refresh();
    f.settle(1, 9);
    await newest;
    await rendered();
    f.harness.frames.length = 0;
    f.settle(0, 3);
    await rendered();
    expect(plainText(f.harness)).not.toContain("3.000000");
    const failed = f.refresh();
    f.queries[2]!.reject(new Error("host unavailable"));
    await failed;
    await rendered();
    expect(plainText(f.harness)).toContain("unavailable");
  } finally {
    f.harness.unmount();
  }
});
