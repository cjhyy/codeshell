import { expect, test } from "bun:test";
import { UsageLedger } from "../cost-ledger/store.js";
import {
  currentUsageAttempt,
  markCurrentUsageAttemptNotSent,
  usageTrackingFetch,
  withUsageAttempt,
  withUsageOwner,
} from "../cost-ledger/context.js";
import {
  ModelRequestBoundaryError,
  requestBoundaryFetch,
  withModelRequestBoundary,
  withProviderRequestProjection,
} from "./context.js";
import { createEphemeralModelRequestSigner } from "./access.js";
import { Transcript } from "../session/transcript.js";

const identity = { provider: "openai", model: "synthetic-model" };
test("physical attempt identity remains available when accounting fails before fetch", async () => {
  const ledger = new UsageLedger();
  ledger.begin = () => {
    throw new Error("synthetic ledger failure");
  };
  const owner = ledger.owner("same-sid");
  let observed: ReturnType<typeof currentUsageAttempt>;
  let sends = 0;
  const fetch = usageTrackingFetch(async () => {
    observed = currentUsageAttempt();
    sends++;
    return new Response("{}");
  });
  await withUsageOwner(owner, () =>
    withUsageAttempt(identity, true, () => fetch("http://fixture.invalid")),
  );
  expect(sends).toBe(1);
  expect(observed!.requestId).toMatch(/^[a-f0-9]{64}$/);
  expect(observed!.accountingSessionId).toBe(owner.accountingSessionId);
  expect(ledger.summary().partial).toBe(true);
});

test("preflight rejection records known not-sent zero usage instead of unknown billed usage", async () => {
  const ledger = new UsageLedger();
  const owner = ledger.owner("same-sid");
  const transcript = Transcript.inMemory("synthetic-owner");
  let sends = 0;
  const fetch = usageTrackingFetch(
    requestBoundaryFetch(
      async () => {
        sends++;
        return new Response("{}");
      },
      currentUsageAttempt,
      markCurrentUsageAttemptNotSent,
    ),
  );
  const body = { model: identity.model, messages: [{ role: "user", content: "synthetic input" }] };
  await expect(
    withUsageOwner(owner, () =>
      withUsageAttempt(identity, true, () =>
        withModelRequestBoundary(
          {
            subject: {
              sessionId: owner.sessionId,
              sessionInstanceId: owner.accountingSessionId,
              storageScopeId: "a".repeat(64),
              ephemeral: true,
            },
            signer: createEphemeralModelRequestSigner(),
            transcript,
            compositionDigest: "b".repeat(64),
            configVersion: 0,
            ...identity,
          },
          undefined,
          undefined,
          () =>
            withProviderRequestProjection("openai-chat", body, () =>
              fetch("http://fixture.invalid", {
                body: JSON.stringify({ ...body, model: "mutated" }),
              }),
            ),
        ),
      ),
    ),
  ).rejects.toBeInstanceOf(ModelRequestBoundaryError);
  expect(sends).toBe(0);
  expect(ledger.summary()).toMatchObject({
    requests: 1,
    notSentRequests: 1,
    unknownUsageRequests: 0,
    unknownCostRequests: 0,
    knownEstimatedCostUsd: 0,
  });
});
